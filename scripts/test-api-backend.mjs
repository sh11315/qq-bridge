// 直连 OpenAI 兼容后端（合并自「自定义版」）的离线回归测试。
//
// 全部走注入的假 fetch，不联网、不读写真实 API Key、不依赖 DSH / NapCat。
// 覆盖：
//   1. 配置归一（默认值、夹取、逗号字符串兼容）
//   2. 路由矩阵：owner / 白名单 → agent；其余 + api.enabled → api；closed-agent 不开后门
//   3. 群聊触发：@自己 / 引用自己 / 唤醒词 / all；@全体不回
//   4. 请求体：system 在最前、推理参数只在显式配置时带
//   5. 重试：429/5xx 重试、4xx 不重试、重试耗尽抛出；思考过程写日志
//   6. 会话历史：裁剪、从 user 开始、TTL、落盘回读
//   7. 后端门面：私聊必回、群里没叫到不回、/reset、超长截断、缺 Key 跳过
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  API_DEFAULTS,
  DEFAULT_SYSTEM_PROMPT,
  ApiChatClient,
  ApiHistoryStore,
  createApiChatBackend,
  isAtAll,
  isAtSelf,
  isRetryableError,
  maskKey,
  normalizeApiConfig,
  resolveReplyRoute,
  shouldRespond,
} from '../src/api-chat.js';

let failed = 0;
function assert(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { console.error(`❌ ${label}`); failed = 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-api-backend-'));

// ── 1. 配置归一 ───────────────────────────────────────────────────────────
{
  const d = normalizeApiConfig(undefined);
  assert(d.enabled === false && d.model === API_DEFAULTS.model, '缺省 api 段：关闭、用默认模型');
  assert(d.groupTrigger === 'at' && d.allowImages === false, '缺省：群聊只回 @、不发图片');
  assert(d.maxRetries === 2 && d.timeoutMs === 60000, '缺省：重试 2 次、超时 60s');

  const n = normalizeApiConfig({
    enabled: 'yes', // 只有真正的 true 才算开启（防止字符串真值误开）
    baseUrl: 'https://example.com/v1/',
    model: '  ',
    temperature: 99,
    maxRetries: -5,
    timeoutMs: 10,
    wakeWords: '小鲸鱼, 在吗 ,',
    groupTrigger: 'everyone',
  });
  assert(n.enabled === false, 'enabled 只认布尔 true（字符串不算）');
  assert(n.baseUrl === 'https://example.com/v1', 'baseUrl 去掉末尾斜杠');
  assert(n.model === API_DEFAULTS.model, '空白 model 回退默认');
  assert(n.temperature === 2, 'temperature 夹取到上限 2');
  assert(n.maxRetries === 0, '负的 maxRetries 归零');
  assert(n.timeoutMs === 1000, '过小的 timeoutMs 抬到 1000');
  assert(n.groupTrigger === 'at', '非法 groupTrigger 回退 at');
  assert(Array.isArray(n.wakeWords) && n.wakeWords.length === 2, 'wakeWords 支持逗号字符串并去空项');

  // thinkingBudget：以前缺上限（clamp 的 max 没传），填成 999999 会让服务端直接 400。
  const t = normalizeApiConfig({ thinkingBudget: 2048 });
  assert(t.thinkingBudget === 2048, 'thinkingBudget 从配置读到后原样保留');
  assert(normalizeApiConfig({ thinkingBudget: -5 }).thinkingBudget === 0, '负数 thinkingBudget 归零');
  assert(normalizeApiConfig({ thinkingBudget: 999999 }).thinkingBudget === 32000, '过大的 thinkingBudget 夹取到 32000');
  assert(normalizeApiConfig({ thinkingBudget: '2048' }).thinkingBudget === 2048, '字符串数字也能转成 thinkingBudget');
}

// ── 2. 路由矩阵 ───────────────────────────────────────────────────────────
{
  const r = (input) => resolveReplyRoute(input);
  assert(r({ isOwner: true, whitelisted: false, apiEnabled: true, mode: 'reserved2' }) === 'agent', 'owner 永远走 DSH Agent');
  assert(r({ isOwner: false, whitelisted: true, apiEnabled: true, mode: 'reserved2' }) === 'agent', '白名单命中走 DSH Agent');
  assert(r({ isOwner: false, whitelisted: false, apiEnabled: true, mode: 'reserved2' }) === 'api', '非白名单 + api 开启 → 直连 api');
  assert(r({ isOwner: false, whitelisted: false, apiEnabled: false, mode: 'reserved2' }) === null, 'api 关闭 → 不处理（原行为）');
  assert(r({ isOwner: true, whitelisted: false, apiEnabled: true, mode: 'closed-agent' }) === 'agent', 'closed-agent 下 owner 仍走 Agent');
  assert(r({ isOwner: false, whitelisted: false, apiEnabled: true, mode: 'closed-agent' }) === null, 'closed-agent 不给直连 api 开口子');
}

// ── 3. 群聊触发 ───────────────────────────────────────────────────────────
{
  const at = [{ type: 'at', data: { qq: '100000002' } }, { type: 'text', data: { text: ' 在吗' } }];
  const atAll = [{ type: 'at', data: { qq: 'all' } }];
  assert(isAtSelf(at, 100000002), '能识别 @自己');
  assert(!isAtSelf(at, 111), '不会把 @别人 当 @自己');
  assert(isAtAll(atAll), '能识别 @全体成员');

  const base = { kind: 'group', segments: [{ type: 'text', data: { text: 'hi' } }], text: 'hi', selfId: 100000002, quoteTargetIsSelf: false, wakeWords: [] };
  assert(shouldRespond({ ...base, trigger: 'all' }) === true, 'groupTrigger=all：群消息都回');
  assert(shouldRespond({ ...base, trigger: 'at' }) === false, 'groupTrigger=at：普通群消息不回');
  assert(shouldRespond({ ...base, trigger: 'at', segments: at, text: '在吗' }) === true, '被 @ 时回');
  assert(shouldRespond({ ...base, trigger: 'at', quoteTargetIsSelf: true }) === true, '引用了机器人时回');
  assert(shouldRespond({ ...base, trigger: 'at', segments: atAll, text: '' }) === false, '@全体不回（避免刷屏）');
  assert(shouldRespond({ ...base, trigger: 'at', text: '小鲸鱼 你好', wakeWords: ['小鲸鱼'] }) === true, '以唤醒词开头时回');
  assert(shouldRespond({ ...base, trigger: 'at', text: '你好 小鲸鱼', wakeWords: ['小鲸鱼'] }) === false, '唤醒词不在开头不回');
  assert(shouldRespond({ ...base, kind: 'private', trigger: 'at' }) === true, '私聊必回');
}

// ── 4. 请求体 ─────────────────────────────────────────────────────────────
{
  const c = new ApiChatClient({ model: 'm', apiKey: 'k', systemPrompt: '' });
  const body = c.buildBody([{ role: 'user', content: 'hi' }]);
  assert(body.messages[0].role === 'system', 'system 永远排在最前');
  assert(body.messages[0].content === DEFAULT_SYSTEM_PROMPT, '未配人格时用内置纯文本人格');
  assert(body.stream === false && body.model === 'm', '非流式 + 指定模型');
  assert(body.reasoning_effort === undefined && body.thinking === undefined, '没配推理参数时不带（兼容不认识的厂商）');

  const c2 = new ApiChatClient({ model: 'm', apiKey: 'k', reasoningEffort: 'max', thinkingType: 'enabled', thinkingBudget: 2048 });
  const b2 = c2.buildBody([]);
  assert(b2.reasoning_effort === 'max', '显式配置时带 reasoning_effort');
  assert(b2.thinking.type === 'enabled' && b2.thinking.budget_tokens === 2048, 'thinking 类型与预算一起带');

  // 配置 → 客户端 → 请求体这条链路（配置归一曾把 budget 吃掉，只有构造器直传的用例是绿的）
  const fromFile = ApiChatClient.fromConfig(normalizeApiConfig({ model: 'm', apiKey: 'k', thinkingType: 'enabled', thinkingBudget: 2048 }));
  const b3 = fromFile.buildBody([]);
  assert(b3.thinking?.type === 'enabled' && b3.thinking?.budget_tokens === 2048, '从 config.json 归一后的 thinkingBudget 也会进请求体');
}

// 假的 fetch：按脚本依次返回
function fakeFetch(sequence, calls = []) {
  let i = 0;
  return async (url, init) => {
    calls.push({ url, init });
    const step = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    if (step.throw) throw Object.assign(new Error(step.throw), { name: step.name || 'Error' });
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      async text() { return JSON.stringify(step.body ?? {}); },
    };
  };
}

function okBody(content, reasoning) {
  return {
    choices: [{ message: { content, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// ── 5. 重试与思考过程 ─────────────────────────────────────────────────────
{
  const logs = [];
  const logger = { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) };
  const calls = [];
  const client = new ApiChatClient({
    model: 'm', apiKey: 'secret-key-1234', maxRetries: 2, retryBackoffMs: 1,
    logger, fetchImpl: fakeFetch([{ status: 500, body: { error: { message: 'boom' } } }, { status: 200, body: okBody('好的', '先想一下') }], calls),
  });
  const answer = await client.chat([{ role: 'user', content: 'hi' }], { onReasoning: (t) => logs.push(`HOOK:${t}`) });
  assert(answer === '好的', '500 后重试成功拿到回复');
  assert(calls.length === 2, '500 确实重试了一次');
  assert(calls[0].url.endsWith('/chat/completions'), '请求打到 {baseUrl}/chat/completions');
  assert(calls[0].init.headers.Authorization === 'Bearer secret-key-1234', 'Authorization 头按 Bearer 传');
  assert(logs.some((l) => l.includes('思考过程：先想一下')), 'reasoning_content 写进了日志');
  assert(logs.some((l) => l === 'HOOK:先想一下'), 'onReasoning 钩子也被调用');
  assert(logs.some((l) => l.includes('token 用量')), 'usage 写进了日志');
  assert(!JSON.stringify(logs).includes('secret-key-1234'), '日志里不出现真实 API Key');
}

{
  let n = 0;
  const client = new ApiChatClient({
    model: 'm', apiKey: 'k', maxRetries: 3, retryBackoffMs: 1,
    logger: { warn() {}, info() {} },
    fetchImpl: async () => { n += 1; return { ok: false, status: 400, async text() { return JSON.stringify({ error: { message: 'bad request' } }); } }; },
  });
  let err = null;
  try { await client.chat([{ role: 'user', content: 'x' }]); } catch (e) { err = e; }
  assert(Boolean(err) && err.status === 400, '4xx 抛出带 status 的错误');
  assert(n === 1, '4xx 不重试（重试也没用）');
}

{
  let n = 0;
  const client = new ApiChatClient({
    model: 'm', apiKey: 'k', maxRetries: 1, retryBackoffMs: 1,
    logger: { warn() {}, info() {} },
    fetchImpl: async () => { n += 1; return { ok: false, status: 503, async text() { return '{}'; } }; },
  });
  let err = null;
  try { await client.chat([{ role: 'user', content: 'x' }]); } catch (e) { err = e; }
  assert(Boolean(err) && n === 2, '5xx 重试耗尽后抛出（共 2 次尝试）');
}

{
  const client = new ApiChatClient({
    model: 'm', apiKey: 'k', maxRetries: 1, retryBackoffMs: 1,
    logger: { warn() {}, info() {} },
    fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }); },
  });
  let err = null;
  try { await client.chat([]); } catch (e) { err = e; }
  assert(Boolean(err) && isRetryableError(err), '网络错误被判定为可重试');
}

// ── 6. 会话历史 ───────────────────────────────────────────────────────────
{
  const store = new ApiHistoryStore({ maxHistory: 4, ttlMs: 60000 });
  store.append('k', 'assistant', '孤儿回复'); // 没有 user 开头，裁剪时应被丢掉
  store.append('k', 'user', 'u1');
  store.append('k', 'assistant', 'a1');
  store.append('k', 'user', 'u2');
  store.append('k', 'assistant', 'a2');
  const msgs = store.get('k');
  assert(msgs.length <= 4, '历史条数不超过 maxHistory');
  assert(msgs[0].role === 'user', '历史总是从 user 开始');
  store.reset('k');
  assert(store.get('k').length === 0, 'reset 清空该会话');

  const file = path.join(tmp, 'api-sessions.json');
  const s1 = new ApiHistoryStore({ maxHistory: 4, persistFile: file });
  s1.append('private:1', 'user', '记住我');
  s1.append('private:1', 'assistant', '好的');
  const s2 = new ApiHistoryStore({ maxHistory: 4, persistFile: file });
  assert(s2.get('private:1').length === 2, '会话历史可落盘并回读');
}

// ── 7. 后端门面 ───────────────────────────────────────────────────────────
{
  const sent = [];
  const activity = [];
  const backend = createApiChatBackend({
    config: { enabled: true, apiKey: 'k', model: 'm', baseUrl: 'https://x/v1', maxReplyChars: 10 },
    sendReply: async (key, text) => { sent.push({ key, text }); return true; },
    logger: { info() {}, warn() {}, error() {} },
    appendActivity: (line) => activity.push(line),
    fetchImpl: fakeFetch([{ status: 200, body: okBody('很长的回复'.repeat(60)) }]),
  });

  assert(backend.routeFor({ isOwner: true, whitelisted: false, mode: 'reserved2' }) === 'agent', '门面：owner 路由到 agent');
  assert(backend.routeFor({ isOwner: false, whitelisted: true, mode: 'reserved2' }) === 'agent', '门面：白名单路由到 agent');
  assert(backend.routeFor({ isOwner: false, whitelisted: false, mode: 'reserved2' }) === 'api', '门面：非白名单路由到 api');

  const handledGroup = await backend.handleIncoming({
    kind: 'group', id: 1, event: { user_id: 9, self_id: 1, message: [{ type: 'text', data: { text: '随便聊聊' } }] },
    text: '随便聊聊', plainText: '随便聊聊', quoteTargetIsSelf: false,
  });
  assert(handledGroup === false && sent.length === 0, '群里没被叫到：不回复');

  const handledPrivate = await backend.handleIncoming({
    kind: 'private', id: 9, event: { user_id: 9, self_id: 1, message: [] },
    text: '你好', plainText: '你好', quoteTargetIsSelf: false,
  });
  assert(handledPrivate === true && sent.length === 1, '私聊消息被直连后端接住并回复');
  assert(sent[0].text.endsWith('…（内容过长，已截断）') && sent[0].text.length <= 130, '超长回复按 maxReplyChars 截断');

  const stats = backend.stats;
  assert(stats.handled >= 1 && stats.sessions >= 1, '统计里记录了处理次数与会话数');

  await backend.handleIncoming({ kind: 'private', id: 9, event: { user_id: 9, self_id: 1 }, text: '/reset', plainText: '/reset', quoteTargetIsSelf: false });
  assert(sent.at(-1).text.includes('记忆清空'), '/reset 在直连模式可用');

  // 自己发的消息不处理
  const selfEcho = await backend.handleIncoming({ kind: 'private', id: 9, event: { user_id: 1, self_id: 1 }, text: '我', plainText: '我' });
  assert(selfEcho === false, '忽略机器人自己发的消息');
}

{
  // 缺 Key：即使 enabled=true 也不处理，避免把错误文本发给群友
  const sent = [];
  const backend = createApiChatBackend({
    config: { enabled: true, apiKey: '', model: 'm' },
    sendReply: async (k, t) => { sent.push(t); return true; },
    logger: { info() {}, warn() {}, error() {} },
  });
  const handled = await backend.handleIncoming({ kind: 'private', id: 2, event: { user_id: 2, self_id: 1 }, text: 'hi', plainText: 'hi' });
  assert(handled === false && sent.length === 0, '缺 apiKey 时静默跳过（不发兜底错误给用户）');
}

// ── 8. Key 掩码 ───────────────────────────────────────────────────────────
{
  assert(maskKey('') === '(未设置)', '空 Key 显示未设置');
  const m = maskKey('sk-1234567890');
  assert(m.startsWith('sk-1') && m.includes('*') && !m.includes('234567890'), 'Key 掩码只保留前几位');
}

// ── 9. 用量回调：直连调用的 token 用量要能交给账本（否则成本报表盲区）──────
{
  const seen = [];
  const backend = createApiChatBackend({
    config: { enabled: true, apiKey: 'k'.repeat(24), baseUrl: 'http://stub/v1', model: 'deepseek-chat', maxRetries: 0 },
    sendReply: async () => true,
    logger: { info() {}, warn() {}, error() {} },
    onUsage: (payload) => seen.push(payload),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: '喵' } }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        });
      },
    }),
  });
  await backend.handleIncoming({ kind: 'private', id: 'cx9', event: { user_id: 2, self_id: 1, message: [] }, text: '在吗', plainText: '在吗' });
  assert(seen.length === 1, '直连回合触发一次 onUsage 回调');
  assert(seen[0]?.key === 'private:cx9' && seen[0]?.model === 'deepseek-chat', 'onUsage 带上 QQ 会话 key 与实际模型');
  assert(seen[0]?.usage?.total_tokens === 110, 'onUsage 原样携带 usage');
}

console.log('');
if (failed) {
  console.error('❌ test-api-backend 有失败项');
  process.exit(1);
}
console.log('🎉 test-api-backend 全部通过');
