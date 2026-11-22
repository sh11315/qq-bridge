// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 出站文本的敏感信息拦截**统一由桥接负责**（bridge.js 的 auditAndSend / 各发送端点的
// SENSITIVE_RE 校验）：所有 QQ 发送都经由桥接 HTTP API，因此 MCP 侧不再重复实现一遍。
// 这里 import 只用于「出站审计口径一致」的说明，不在 MCP 内做拦截——
// 在 MCP 里拦会连「安全拒绝理由」都拿不到，反而让模型无法把话说清楚。
import { SENSITIVE_RE } from './sensitive.js';
import { serializeModelData } from './qq-model-view.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 说明：本文件曾经有一对 escapeCqText() / messageSegments()，用于在 MCP 侧构造消息段。
// 它们从来没有被任何工具调用（发送一律走桥接的 /api/send/*，由桥接统一构造文本段并做
// CQ 转义，见 bridge.js 的 onebotSend），属于"看起来在防护、实际是死代码"的假安全。
// 这里直接删除，避免以后有人以为 MCP 侧还有一道 CQ 转义而放松桥接那一层。

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  let res;
  try {
    res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    // 裸 "fetch failed" 对模型和运维都没有信息量：实测一周里 qq_status 31 次失败全是这个，
    // 而真实原因是 NapCat 容器没起/QQ 掉线。这里翻译成人话并给出下一步动作。
    const code = String(error?.cause?.code || error?.code || '');
    const detail = code === 'ECONNREFUSED'
      ? '连接被拒绝（端口没人监听）'
      : code === 'ETIMEDOUT' || /timeout/i.test(String(error?.message || ''))
        ? '连接超时'
        : /fetch failed/i.test(String(error?.message || ''))
          ? '网络请求失败'
          : errorText(error, '网络错误');
    throw new Error(`连不上 NapCat（${detail}）：OneBot HTTP ${httpUrl} 未就绪。常见原因：NapCat 容器/NapCat 未启动、QQ 已掉线、httpUrl 端口不对。先看「NapCat」页或容器日志，恢复后再重试。`);
  }
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  //
  // 必须与桥接的校验口径**完全一致**（bridge.js 的 startConsoleServer：长度 16~128、
  // 只允许 [A-Za-z0-9_-]，不合法就忽略并回退 state/console-token）。否则用户手填一个
  // 短令牌时桥接会正常运行，而 MCP 拿着这个桥接根本不认的值去请求 —— 每个工具都 401，
  // 且错误信息里看不出原因是"config.json 里的令牌格式不合法"。
  try {
    const c = getConfig();
    const configured = String(c.consoleToken ?? '').trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 把桥接返回的 `error` 变成可读文本。
 *
 * 为什么必须有：桥接个别分支会回一个**对象**（例如 `{code, message}`），直接
 * `new Error(obj)` 会把它 String 成 "[object Object]" —— 模型和运维都读不到任何信息。
 * r3 的已知未修项里就记着 `qq_wait_for_messages` 出现过 `error: "\"Error: [object Object]\""`。
 */
function errorText(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      if (text && text !== '{}') return text.slice(0, 500);
    } catch {}
    const message = value.message ?? value.msg ?? value.error;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const headers = agentHeaders(rest.headers);
  // 桥接重启时这里会抛 ECONNREFUSED/ECONNRESET（或裸 fetch failed）。原始错误对模型没有信息量，
  // 它只会理解成「连接不稳，再试一次」，于是同一回合里反复重试、把回合拖成十几步。
  // 这里翻译成可执行结论：桥接暂时不可用 → 不要重试、直接收尾、等下次唤醒。
  let res;
  try {
    res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const code = String(error?.cause?.code || error?.code || '');
    const transient = code === 'ECONNREFUSED' || code === 'ECONNRESET'
      || /fetch failed|Headers Timeout|ECONN/i.test(String(error?.message || ''));
    if (transient) {
      throw new Error(`桥接暂时不可用（${code || '连接中断'}）：桥接可能正在重启/停止，连接断开后本回合后续工具调用都会失败。不要重试，也不要据此判断消息有没有发出去；请直接收尾（qq_mark_read 或 qq_set_wake_config），等下一次唤醒再继续。`);
    }
    throw error;
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  // 401 不是业务错误而是凭证问题：模型若只看到 "HTTP 401" 会重复重试同一把错令牌。
  // 直接把可做的动作写清楚（用唤醒提示里的会话令牌 / 重新读 prompt）。
  if (res.status === 401) {
    throw new Error('会话令牌无效或已过期：请原样使用唤醒提示里的【会话令牌】，不要猜或复用别的会话的令牌；也可以重新调用 qq_get_prompt 取最新令牌后再试。');
  }
  if (!res.ok) {
    throw new Error(errorText(body?.error, `桥接 API HTTP ${res.status}`));
  }
  // 桥接的部分端点会用 200 + {ok:false,error} 表达业务失败（例如发送被审计拦截）。
  // 不检查 body.ok 会把「被拦截」当成「发送成功」上报给模型 —— 模型据此认为消息已发出，
  // 于是不再重试也不告诉用户，是典型的静默错误。
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(errorText(body.error, '桥接 API 返回 ok:false（未说明原因）'));
  }
  return body;
}

/**
 * 桥接 API 请求头（含控制台令牌、x-agent-call 与调用方附加头）。
 * 拆出来是为了长轮询通道复用同一套鉴权，避免两条通路口径漂移。
 */
function agentHeaders(extra = {}) {
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(extra ?? {})
  };
  // 声明「这是一次智能体调用」。桥接据此把「没带会话令牌」判定为**拒绝**，而不是
  // 退化成「管理端全权」——所以这个头绝不能随 token 一起被省略。历史上 331/355/379/877
  // 行用 `...(token ? {headers:{...}} : {})` 把整个头省掉了，于是「模型漏传 token」
  // 不是被拒绝，反而提权成控制台权限（confused deputy）。
  // 令牌本身仍然只在真有时才发：/api/status 的模式探测（legacyReadToolAllowed）本来就是
  // 无令牌调用，桥接对它单独放行并按最小对象返回。
  headers['x-agent-call'] = '1';
  return headers;
}

/**
 * 长轮询专用 POST（`node:http`，不经过 undici）。
 *
 * 为什么必须单独一条：Node 的全局 `fetch` 是 undici，自带 300 秒 `headersTimeout`。
 * 而 `qq_wait_for_messages` 的常规用法就是 `timeoutMs=300000` 的沉睡前观察 ——
 * 客户端会在第 301 秒以 `fetch failed / Headers Timeout Error` 断掉，桥接侧的
 * 长轮询却还在跑满自己的预算：AI 拿不到结果只能重试，而 `activeWaits` 仍占着会话
 * （重新等待被 429），于是空转烧 token（见 issue #24）。`node:http` 没有默认响应超时，
 * 超时完全由这里的计时器按调用方预算控制。
 */
function agentApiLongPoll(path, init = {}) {
  const timeoutMs = Math.max(1000, Number(init.timeoutMs) || 15000);
  const url = new URL(`${agentApiBase()}${path}`);
  const body = init.body == null ? '' : String(init.body);
  const headers = agentHeaders(init.headers);
  headers['content-length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let res;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）`);
      finish(error);
      req?.destroy(error);
      res?.destroy();
    }, timeoutMs);
    timer.unref?.();
    try {
      req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: init.method || 'GET',
        headers,
        timeout: 0
      }, (response) => {
        res = response;
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          // 桥接的 wait 响应本来就是小 JSON；超过 4MB 说明对端异常，别把内存吃光。
          if (size > 4 * 1024 * 1024) {
            finish(new Error('等待响应体过大，已中止'));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => finish(error));
        response.on('aborted', () => finish(new Error('等待响应中断')));
        response.on('close', () => { if (!response.complete) finish(new Error('等待响应中断')); });
        response.on('end', () => {
          if (settled) return;
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
          const status = response.statusCode || 0;
          if (status === 401) {
            finish(new Error('会话令牌无效或已过期：请原样使用唤醒提示里的【会话令牌】，不要猜或复用别的会话的令牌；也可以重新调用 qq_get_prompt 取最新令牌后再试。'));
            return;
          }
          if (status < 200 || status >= 300) {
            finish(new Error(errorText(parsed?.error, `桥接 API HTTP ${status}`)));
            return;
          }
          if (parsed && typeof parsed === 'object' && parsed.ok === false) {
            finish(new Error(errorText(parsed.error, '桥接 API 返回 ok:false（未说明原因）')));
            return;
          }
          finish(null, parsed);
        });
      });
      req.on('error', (error) => finish(error));
      req.end(body);
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

async function authorizeRead(key) {
  // 会话令牌必须显式携带：桥接已把空令牌的请求一律拒绝（避免把该端点变成免鉴权入口）。
  // 旧只读工具没有令牌，因此它们改由 legacyReadToolAllowed() 做模式判定，不再调用本函数。
  throw new Error('旧只读工具没有会话令牌；请使用带会话令牌的 v2 读工具');
}

// 旧只读工具（qq_status 之外的 qq_list_groups / qq_get_group_members / qq_get_group_history）
// 没有会话令牌，因此**只能在封闭 agent（管理员私聊）里使用**。
//
// 这里用「确认是 closed-agent 才放行」的白名单写法，而不是「看到 reserved2 就拒绝」的黑名单写法：
// 桥接的 /api/status 在「带 agent 令牌」时返回的是最小状态对象（不含 mode 字段），
// 用 `status?.mode === 'reserved2'` 判断会得到 undefined ⇒ 黑名单判定为假 ⇒ 旧工具被放行，
// 等于在二代仿真模式下把白名单群名、群成员名单注入模型上下文。
async function legacyReadToolAllowed() {
  const status = await agentApi('/api/status');
  return String(status?.mode ?? '') === 'closed-agent';
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.2.1-r1' });

// ── 工具开关必须在**注册期**生效，而不是只在校验期 ──────────────────────────
//
// 为什么：每个工具的描述 + 参数 schema 都会随 system prompt 在**每一次**请求里重发
// （实测 41 个工具约 8.8k token）。只在校验时 403 的话，被关掉的工具依然占着上下文、
// 依然会让模型看见并调用它（然后拿到一个错误），等于「关了个寂寞」。
//
// 这里用一个注册过滤器统一处理：开关关闭 ⇒ 该工具根本不注册 ⇒ 既省 token 又不给模型误调的机会。
// DSH 在启动时读取工具清单，所以关掉/打开后需要重启 DSH 才会刷新（控制台面板已注明）。
//
// 只列**各模式共用的工具不在其中**：qq_send_group_message / qq_send_private_message / qq_reply
// 同时服务 chat / reserved / closed-agent 模式，用 v2 的开关去决定它们是否注册会误伤其它模式，
// 所以这三个仍然只在调用时由桥接校验。
const TOOL_CONFIG_FLAGS = {
  qq_get_prompt: 'getPrompt',
  qq_get_unread_messages: 'getUnread',
  qq_get_recent_messages: 'getRecent',
  qq_social_state: 'socialState',
  qq_mark_read: 'markRead',
  qq_set_wake_config: 'setWakeConfig',
  qq_plan_wake: 'planWake',
  qq_send_burst: 'sendBurst',
  qq_send_message: 'sendMessage',
  qq_wait_for_messages: 'waitMessages',
  qq_report_feedback: 'feedback',
  qq_get_my_recent_messages: 'getMyRecent',
  qq_get_message_detail: 'getMessageDetail',
  qq_get_active_members: 'getActiveMembers',
  qq_get_group_members: 'getGroupMembers',
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  qq_memory_remove: 'memory',
  qq_memory_clear: 'memory',
  qq_slang_query: 'slangQuery',
  qq_slang_submit: 'slangSubmit',
  qq_send_voice: 'sendVoice',
  qq_list_voices: 'sendVoice',
  // 下面这些曾经漏登记。漏一个不是"多注册一个工具"那么轻：桥接那边按 `v2ToolEnabled(flag)`
  // 在**调用期**一律 403，而这里不登记就等于"控制台显示已关闭、模型每次请求仍收到它的完整
  // 描述与参数 schema，然后调用它、再拿到 403"——既白烧 token（本文件开头 176 行起就是为省这份
  // token 才改注册期过滤的），又诱导模型误调。`qq_set_sticker_remark` 默认就是 `false`
  // （见 bridge.js 的 socialV2.tools 默认表），所以此前它一直是"默认关闭却仍然可见"。
  qq_send_poke: 'sendPoke',
  qq_get_message_images: 'getImages',
  qq_get_forward_msg: 'getForwardMsg',
  qq_list_stickers: 'listStickers',
  qq_get_sticker_image: 'getStickerImage',
  qq_send_sticker: 'sendSticker',
  qq_collect_sticker: 'collectSticker',
  qq_get_self_image: 'getSelfImage',
  qq_sticker_note: 'stickerNote',
  // 共用小黑板（跨功能会话共享的短期事实板）；三件套共用 board 开关。
  qq_board_read: 'board',
  qq_board_write: 'board',
  qq_board_forget: 'board',
  qq_set_sticker_remark: 'setStickerRemark',
  // 主对话把「查资料/看图/看表情」交给子智能体（v1.8 试点）。
  qq_delegate_search: 'delegate',
  qq_delegate_image: 'delegate',
  qq_delegate_sticker: 'delegate',
};
const disabledTools = [];
{
  const registerTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const flag = TOOL_CONFIG_FLAGS[name];
    if (flag && cfg.socialV2?.tools?.[flag] === false) {
      disabledTools.push(`${name}(${flag})`);
      return undefined;
    }
    if (typeof rest[0] === 'string' && !rest[0].includes("仅当用户当前这条消息确实需要该能力时")) {
      rest[0] = rest[0] + "\n（仅当用户当前这条消息确实需要该能力时才调用；不要为了试探或浏览工具而调用；不属于本功能会话的工具已被隐藏或会被拒绝。）";
    }
    return registerTool(name, ...rest);
  };
}

// qq_status 是模型最爱的“试探”工具：NapCat 断连时实测一周被调 31 次、次次同错。
// 连续失败时直接在错误文本里要求停止，避免每回合白烧一次工具往返。
const statusFailure = { count: 0, at: 0 };

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。连不上 NapCat 时会返回具体原因；失败一次就不要再重复调用，也不要把“查不到”编造成在线/离线结论——先让主人看控制台 NapCat 页或容器日志。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      statusFailure.count = 0;
      return { content: [{ type: 'text', text: serializeModelData({ ...login, online: status.online, good: status.good }) }] };
    } catch (error) {
      const now = Date.now();
      if (now - statusFailure.at > 5 * 60_000) statusFailure.count = 0;
      statusFailure.at = now;
      statusFailure.count += 1;
      const stop = statusFailure.count >= 2
        ? `（已连续失败 ${statusFailure.count} 次：停止调用 qq_status，不要再试探；直接告诉对方暂时查不到登录状态，或请主人检查 NapCat）`
        : '（失败一次就不要再重复调用）';
      return { content: [{ type: 'text', text: `查询失败：${errorText(error, '未知错误')}${stop}` }], isError: true };
    }
  }
);

// ── 旧只读工具：**按启动时的桥接模式决定是否注册** ─────────────────────────
//
// 为什么必须在注册期就砍掉（而不是只在调用期 403）：
//   每个工具的描述 + 参数 schema 都随 system prompt 在**每一次**请求里重发。
//   实测一份 reserved2 会话的请求头是「58 个工具 / 45.5 KB schema（≈14k token/次）」，
//   其中 3 个旧只读工具在 reserved2 下**必然**返回 403，却照样占着 2500+ 字节；
//   更要命的是它们会诱导模型误调（实测 turn10 有一次 qq_get_group_members → 403，白烧一步）。
//   本文件开头（TOOL_CONFIG_FLAGS 那段）已经为「关掉的工具」立过同样的规矩，这里补齐模式维度。
//
// 语义：旧只读工具没有会话令牌，`legacyReadToolAllowed()` 只放行 closed-agent。
//   所以只有在 closed-agent 下注册它们才有意义。探测失败（读不到状态文件）时按「注册」处理：
//   那种情况下所有 QQ 工具都不可用，少注册只会让模型看到更少的失败路径，不必激进。
//
// ⚠️ 为什么读 `state/mode.json` 而**不**去问 `/api/status`：
//   注册发生在模块加载期，走网络就得用 top-level await；而本文件会被若干离线回归
//   （test-audit-security-mcp.mjs）用 `vm`/`new Function` 求值，那里没有 TLA —— 会直接
//   `ReferenceError: await is not defined`，把整批断言打红。模式文件是桥接每次切换模式时
//   原子写出的（bridge.js 的 writeMode），与 `/api/status` 同源，读盘既准确又是同步的。
const bootBridgeMode = (() => {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'state', 'mode.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return String(parsed?.mode ?? '').trim();
  } catch { return ''; }
})();
const registerLegacyReadTools = bootBridgeMode === '' || bootBridgeMode === 'closed-agent';
if (!registerLegacyReadTools) {
  console.error(`[snowluma-safe] 当前桥接模式 ${bootBridgeMode}：不注册旧只读工具（qq_list_groups / qq_get_group_history），改用带令牌的 v2 读工具`);
}

if (registerLegacyReadTools) {
server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token：只允许在封闭 agent（管理员私聊）里使用。
    // 判定失败一律拒绝（fail-closed），不依赖「看到某个模式才拒绝」的黑名单写法。
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${errorText(error, '未知错误')}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);
}

// 群成员列表：**换成 v2 形态**（key + token）。
//
// 为什么不再沿用旧的无令牌版本：它是 qq-chat-v2 预设里唯一被点名的"拿 QQ 号"的途径
// （见 dsh/agent-presets/qq-chat-v2/agent.cordis.yml 第 6 条），但旧版在 reserved2 下必然 403
// —— 预设教模型用一个永远失败的工具，等于每次都白烧一步。改成 v2 后同一个名字在两种模式下都成立。
server.tool(
  'qq_get_group_members',
  '列出指定群的成员（只读）：QQ 号、昵称、群名片。等特定的人、要 @ 某个人、或需要确认谁在群里时用；QQ 号取返回里的 userId。只返回白名单群，且只读取桥接允许的会话。',
  {
    key: z.string().describe('会话 key，格式 group:群号'),
    token: z.string().optional().describe('会话令牌（见唤醒提示中的【会话令牌】；closed-agent 模式不需要）'),
    limit: z.number().optional().describe('最多返回多少成员，默认 50，最大 100')
  },
  async ({ key, token, limit }) => {
    try {
      const q = new URLSearchParams({ key });
      if (limit != null) q.set('limit', String(limit));
      // token 可选：closed-agent（管理员私聊）里代理没有会话令牌，走的是操作者路径；
      // 桥接那边的白名单/模式判定对**这条**请求同样生效（不依赖 header 是否存在）。
      const data = await agentApi(`/api/socialV2/group-members?${q.toString()}`, token ? { headers: { 'x-agent-token': token } } : {});
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取群成员失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

if (registerLegacyReadTools) {
server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${errorText(error, '未知错误')}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);
}

server.tool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（可选；和 replyToMessageId 可同时用）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, atUserId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        // token 既放 body（兼容旧调用）又放 header：桥接的「agent 流量」判定基于 header，
        // 只带 body 会让这条请求在桥接眼里像控制台请求，绕过 agent 专用的闸门与审计。
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, atUserId: atUserId ?? null, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息并发送文本；replyToMessageId 是被引用消息 id（非零整数，可为负数，可先用 qq_get_unread_messages / qq_get_message_detail 查）。桥接会校验该 id 属于当前会话，目标群必须在 allow.groups 白名单内。只在需要明确“回的是哪条”时引用：指向的不是最新一条，或连续几句指向不同消息/不同人；上下文唯一或刚接最新消息时不要引用。reserved2 下必须带会话令牌 token。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '向指定 QQ 好友发一条私聊；带 replyToMessageId 时以引用形式发出（非零整数，可为负数）。reserved2 下优先用 qq_send_message，并必须带会话令牌 token；目标 QQ 必须在 allow.private 白名单内，群会话里只允许私聊 owner（ownerQQ）且必须是 owner 本轮触发。发送后不要输出“已发送”类汇报。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看未读消息，不自动标记已读。大量积压或快照 partial=true 时，用 afterSeq=readThroughSeq 从水位后按时间顺序补读；从最早未读开始传 0。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 30，最大 100'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('读取本地 seq 大于此水位的最早一页；省略则沿用返回最新一页的旧行为')
  },
  async ({ key, token, limit, afterSeq }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}${afterSeq === undefined ? '' : `&afterSeq=${afterSeq}`}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_search_history',
  '在当前会话的历史消息里检索（只读）：按关键词/时间窗/发送者找以前说过的原话。问“你还记得…”时优先用它，别只靠最近消息快照。会自动剥掉“你还记得/记不记得/我说过”等句式；“4只”这类短答案不会被过滤；问“几只/多少”时额外扫“数字+量词”。默认只查本会话；scope=user 可按 QQ 号跨群（仅主人/管理员）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    query: z.string().describe('检索问句或关键词，如“你还记得我有几只猫吗”“上次说的那家店”'),
    hours: z.number().int().min(1).max(8760).optional().describe('向前查多少小时，默认 168（7 天）'),
    limit: z.number().int().min(1).max(50).optional().describe('最多返回条数，默认 20'),
    scope: z.enum(['current', 'user']).optional().describe('current=当前会话（默认）；user=按 QQ 号跨群（仅主人/管理员）'),
    userId: z.string().optional().describe('scope=user 时必填：要查的 QQ 号；current 下可作发送者过滤')
  },
  async ({ key, token, query, hours, limit, userId, scope }) => {
    try {
      const data = await agentApi('/api/socialV2/search-history', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, query, hours, limit, userId: userId ?? '', scope: scope ?? 'current' })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `历史检索失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_generate_image',
  '生成一张图片并直接发到当前会话（出图，不是发表情库）。prompt 描述画面；可选 size、referenceMessageId（用本会话某条消息里的图做参考，图生图）。只在联网/管理员回合可用；需要管理员先在 config.imageGen 配置 provider/model/apiKey，未配置会返回可读原因。出图有频率与每日上限，不要连续调用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    prompt: z.string().describe('画面描述（中文即可），最多 2000 字'),
    size: z.string().optional().describe('尺寸，如 1024x1024（默认取配置）'),
    referenceMessageId: z.string().optional().describe('参考图的消息 id 或本地 seq（可选，用于图生图/改图）')
  },
  async ({ key, token, prompt, size, referenceMessageId }) => {
    try {
      const data = await agentApi('/api/images/generate', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, prompt, size, referenceMessageId }),
        timeoutMs: 240000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `出图失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话已查看的未读消息标记为已读。throughSeq 必须用最近读取结果里的 readThroughSeq；省略会清空当前全部未读（把读取后新到达的消息一起标掉，危险），除非明确要清空否则不要省略。收尾前先按 qq_wait_for_messages 的描述完成一次沉睡前观察，再决定 mark_read。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的二代唤醒配置：mode（无限期/有限时间）、提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 适合等某个人回复时用（群友 QQ 号，最多 20 个，私聊不适用；可从 qq_get_active_members / qq_get_message_detail 取）；triggers.poke 开启后有人拍一拍会唤醒。可同时传 throughSeq 顺带标记已读。设置潜水/下一次唤醒前，必须先按 qq_wait_for_messages 的描述完成一次沉睡前观察。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可顺带标记已读（用上次 readThroughSeq）；不传则只设唤醒配置'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号（最多 20；私聊不适用；可从 qq_get_active_members 取 userId）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_plan_wake',
  '给自己排一次「主动唤醒」：X 分钟后到点就叫醒你，时间点和由头都由你定，不走桥接的概率/上限/由头判断。适合你想主动开口但不想现在说（比如晚点再问一句、过会儿分享个东西），或者想给自己留个「待会儿再聊」的念想。计划存进桥接状态、重启不丢；到点唤醒提示里会带上你留的由头。cancel=true 可撤销。到点后想说话就正常发（qq_send_message/qq_reply），不想说直接收尾即可。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    afterMinutes: z.number().min(1).max(1440).optional().describe('多少分钟后叫醒自己（1~1440，默认 20）'),
    note: z.string().max(200).optional().describe('给自己留的由头：到点想说什么/想接着聊什么（≤200 字，会出现在唤醒提示里）'),
    cancel: z.boolean().optional().describe('true=撤销当前已排的计划唤醒')
  },
  async ({ key, token, afterMinutes, note, cancel }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-plan', {
        method: 'POST',
        body: JSON.stringify({ key, afterMinutes, note, cancel }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `安排主动唤醒失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（二代仿真模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具（reserved2 专用）：messages 传字符串=一条、数组=多条；不要用空格分隔中文短句，每条要读起来完整，别把一句话拆两条。gapMode/gapMs/gaps 控制条间间隔（auto 由桥接随机）。引用规则同 qq_reply：只在指向的不是最新一条、或连续几句指向不同消息/不同人时才传 replyToMessageId；上下文唯一就别引用。@ 某人用 atUserId（与引用二选一，别滥用）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      const raw = String(errorText(error, '未知错误'));
      // 一个回合的会话令牌只对这个会话有效：私聊回合里拿它去发群，桥接会回「agent token 无效」，
      // 看起来像 bug。这里直接告诉模型换哪个工具，省一轮试错。
      const hint = /agent token 无效/.test(raw) && String(key || '').startsWith('group:')
        ? '（会话令牌只对当前会话有效：私聊回合要发群，请改用 qq_send_group_message，它会带上群会话自己的令牌）'
        : '';
      return { content: [{ type: 'text', text: `发送失败：${raw}${hint}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${errorText(error, '未知错误')}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_delegate_search',
  '把「联网查资料」这件事交给子智能体：只给它一句查询，它自己搜、自己取舍，最后返回结构化 JSON（summary + sources）。主对话不要自己搜网页；拿到结果用自己的话回答，来源不足就说查到的有限，别转发原始 JSON。仅当当前消息确实需要最新/外部信息时才调用；不要为了试探或浏览工具而调用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    query: z.string().describe('要查什么：一句话即可（≤300 字）'),
    maxSources: z.number().optional().describe('最多几个来源，默认 4、最多 8')
  },
  async ({ key, token, query, maxSources }) => {
    try {
      const data = await agentApi('/api/delegate/search', {
        method: 'POST',
        body: JSON.stringify({ key, token, query, maxSources }),
        headers: { 'x-agent-token': token },
        timeoutMs: 160000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `委派检索失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_delegate_image',
  '把「看一张图」交给子智能体：用 messageId 指向本会话里收到过的一条图片消息，子会话看图后返回结构化 JSON（description/text/emotion/entities）。主对话只用文字上下文；拿到结果用自己的话回答，不要转发原始 JSON、不要自己猜图。仅当当前消息确实需要看某张图、而本会话拿不到图片时才调用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.string(), z.number()]).describe('要看的图片消息 id（可用 qq_get_unread_messages / qq_get_recent_messages 查到）'),
    prompt: z.string().optional().describe('看图要求，一句话；默认「这张图里是什么？把画面和文字说清楚。」')
  },
  async ({ key, token, messageId, prompt }) => {
    try {
      const data = await agentApi('/api/delegate/image', {
        method: 'POST',
        body: JSON.stringify({ key, token, messageId, prompt }),
        headers: { 'x-agent-token': token },
        timeoutMs: 160000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '委派看图失败：' + (errorText(error, '未知错误')) }], isError: true };
    }
  }
);

server.tool(
  'qq_delegate_sticker',
  '把「这是什么表情包/表达什么情绪」交给子智能体：messageId 指向一条表情/图片消息，子会话返回结构化 JSON（description/text/emotion/entities）。拿到结果用自己的话接话，不要转发原始 JSON。仅当当前消息确实需要理解一个表情包时才调用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.string(), z.number()]).describe('表情/图片消息 id'),
    prompt: z.string().optional().describe('额外要求，默认「这是什么表情包？它表达的梗和情绪是什么？」')
  },
  async ({ key, token, messageId, prompt }) => {
    try {
      const data = await agentApi('/api/delegate/sticker', {
        method: 'POST',
        body: JSON.stringify({ key, token, messageId, prompt }),
        headers: { 'x-agent-token': token },
        timeoutMs: 160000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '委派看表情失败：' + (errorText(error, '未知错误')) }], isError: true };
    }
  }
);

server.tool(
  'qq_wait_for_messages',
  '等待分两种用途。purpose="reply"：首答前确认对方有没有补充，按最后来信时间补足 quietMs 静默，静默够了立即返回；读取/思考期间新到的消息也会返回；**绝不代替沉睡前观察**。默认 purpose="messages"：等对方继续说/等回复/睡前观察；先等新消息，收到后按 quietMs 等静默，没有新消息会等到 timeoutMs（单传 quietMs 不会缩短总等待，静默下限默认 10000ms）。**返回里的 canSleepNow / countsAsObservation / hint 直接告诉你能不能收尾、该用多大 timeoutMs——照它做，不要反复试**：canSleepNow=true 可直接 mark_read / set_wake_config；false 时按 hint 一次等满（更短的等待不算观察，满足不了闸门）。直接看 newMessages / unreadCount / readThroughSeq，无需重复查询。沉睡前观察用 messages + timeoutMs=300000，必须放在收尾前，不能放在首答前。全程无人说话返回 preSleepWaitSatisfied=true；观察期间来了新消息返回 preSleepWaitObserved=true（不需参与可收尾，参与了则下次重新观察）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000；bridge 会截到单次最多 60 秒，长观察请分多轮；reply 达到静默即返回，不必等满；沉睡前观察用 messages 并传 300000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      // 必须走长轮询通道：全局 fetch（undici）有 300s headersTimeout，
      // 而沉睡前观察的预算就是 300s（见 agentApiLongPoll 的说明）。
      const data = await agentApiLongPoll('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_board_read',
  '读当前 QQ 会话的「共用小黑板」：块上的内容由所有功能会话（聊天/看图/表情/语音/联网）共享，回答前先扫一眼，避免两条线各说各的。也可用于确认自己刚写没写进去。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
  },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/board?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取小黑板失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_board_write',
  '往当前会话的「共用小黑板」写一条跨会话都用得上的短期事实：天气/温度、约定了什么、对方现在在做什么/状态、你刚查到的结论、刚看过的那张图里有什么。写一次就够，别刷；单条尽量一句话（≤80 字），别记流水账，别写只有这一路自己需要的思考过程。长期稳定的事实请用 qq_memory_append。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    text: z.string().describe('要记的内容，一句话即可，例如「外面下雪，3 度，路滑」')
  },
  async ({ key, token, text }) => {
    try {
      const data = await agentApi('/api/socialV2/board', {
        method: 'POST',
        body: JSON.stringify({ key, text }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `写小黑板失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_board_forget',
  '删掉小黑板上的一条（index 是 qq_board_read / qq_board_write 返回 entries 的下标，从 0 开始），或传 clear=true 清空整块。用于删掉写错、过时或重复的条目。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    index: z.number().int().nonnegative().optional().describe('要删除的条目下标（entries 数组下标，从 0 开始）'),
    clear: z.boolean().optional().describe('true=清空整块小黑板')
  },
  async ({ key, token, index, clear }) => {
    try {
      const body = clear ? { key } : { key, index };
      const data = await agentApi('/api/socialV2/board/clear', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `清理小黑板失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${errorText(error, '未知错误')}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息里的图片/表情，并以图像内容返回（多模态模型可直接看懂）。消息带 [图片]/[表情]/hasMedia=true 时用；引用消息 `[引用 msgId=123 含图1 某人：…]` 里 `msgId=` 后面就是被引用消息 id，直接传它即可看引用里的图；返回「不在可读窗口内」说明已被网关清理，如实说看不到。**只读**：只按 messageId 读该条消息的图，不下载/转发/发送/切会话。动图（GIF/动态表情）会被抽帧拼成网格，按说明里的「行优先 左上→右下」理解动作，别当成九宫格照片；过大图会缩放/重编码，压不到可用体积时返回原因——如实说看不到，不要编造。reserved2 下必须带会话令牌。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${errorText(error, '未知错误')}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/socialV2/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${errorText(error, '未知错误')}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。动图表情会被抽帧拼成多格图（行优先：左上→右下），说明里会写帧数与网格尺寸；体积过大时会自动缩放，说明里会给出原始尺寸。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：${data.note ? '（' + data.note + '）' : ''}` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${errorText(error, '未知错误')}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${errorText(error, '未知错误')}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${errorText(error, '未知错误')}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false) {
  server.tool(
    'qq_send_voice',
    '在指定会话发一条 QQ 语音（把语音库里的音频当语音条发）。voice 传 qq_list_voices 返回的 name（可省略扩展名）。只能发语音库（qq-bridge/audio/）里的文件，不能发本地路径/URL/base64；受时长与频率上限约束，超限会被拒绝。语音是强表达，偶尔用。返回 verified=true 才能对用户说“发了语音”；readback 只对收到的语音有意义，默认关闭。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      voice: z.string().describe('语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）'),
      label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
      verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
      readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
    },
    async ({ key, token, voice, label, verify, readback }) => {
      try {
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            voice: String(voice),
            label: label || '',
            verify: verify !== false,
            readback: readback === true,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送语音失败：${errorText(error, '未知错误')}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_send_tts',
    '把一段文字用 TTS 合成语音并以 QQ 语音条发出（文字转语音）。想开口说话时用这个，不要说"我没有语音功能"。text 建议 1~2 句、不超过 300 字；受频率/时长限制。返回 verified=true 表示语音已落地。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      text: z.string().describe('要说的内容（1~300 字，建议 1~2 句）'),
      label: z.string().optional().describe('可选：会话记录里的说明'),
      verify: z.boolean().optional().describe('是否回读校验（默认 true）')
    },
    async ({ key, token, text, label, verify }) => {
      try {
        const data = await agentApi('/api/socialV2/send-tts', {
          method: 'POST',
          body: JSON.stringify({ key, text: String(text), label: label || '', verify: verify !== false, token }),
          headers: { 'x-agent-token': token },
          timeoutMs: 180000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送 TTS 语音失败：${errorText(error, '未知错误')}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_voices',
    '查看可用的语音库（qq-bridge 的 audio 目录里准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
    },
    async ({ key, token, probe }) => {
      try {
        const q = new URLSearchParams({ key });
        if (probe === false) q.set('probe', '0');
        const data = await agentApi(`/api/socialV2/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取语音库失败：${errorText(error, '未知错误')}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你自己的默认 Q 版形象图片（DeepSeek 小鲸鱼形象）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${errorText(error, '未知错误')}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${errorText(error, '未知错误')}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${errorText(error, '未知错误')}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${errorText(error, '未知错误')}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        {
        const raw = String(errorText(error, '未知错误'));
        const friendly = /消息已过期|内层消息|无法获取转发/.test(raw)
          ? '这条合并转发已经过期或无法读取（QQ 侧限制），可以请对方把内容单独发出来。'
          : `查看合并转发失败：${raw}`;
        return { content: [{ type: 'text', text: friendly }], isError: true };
      }
      }
    }
  );
}

await server.connect(new StdioServerTransport());
