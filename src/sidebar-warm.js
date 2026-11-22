// 需求 C：DSH 重启后**自动**把 dsh-better-sidebar 的 `sidebar_open` 注册起来。
//
// ── 为什么需要这一步（实测到的机制，别凭直觉改）────────────────────────────
// `sidebar_open` 由 dsh-better-sidebar 的侧卡片设置 `agentOpenTools` 门控：
//   src/index.ts:1379  syncOpenToolsGate() —— agentOpenTools === true 时才 registerOpenTool()
//   src/index.ts:1401  settingsFace.get: () => { syncOpenToolsGate(); return viewOf() }
//   src/index.ts:1408  apply() 里也会调一次 syncOpenToolsGate()
// 关键在 :1408 那一次：它发生在插件 apply 的时刻，而 `ownEntryId(ctx)` 需要 loader
// 已经把自己的行挂上（settings.describe() 才看得到）。DSH 冷启动时 loader 尚未 settle，
// 这次调用会拿不到 ns → settingsFace 永远不赋值 → 之后 settings.get 直接返回
// `{ value: undefined }`，`syncOpenToolsGate` 再也不会跑。表现就是：
//   **每次 DSH 重启后 sidebar_open 都不会注册**，直到有人手动访问一次
//   `/sidebar/api/settings.get`（打开 Web 侧栏/设置页就会触发）才补上。
//
// ── 修法 ───────────────────────────────────────────────────────────────────
// DSH 一就绪就自动 POST 一次 `/sidebar/api/settings.get`：这是该插件自己声明的
// 「读取设置」入口，处理函数第一行就是 syncOpenToolsGate()，等于替用户点了那次侧栏。
//
// ── 为什么接在桥接的 DSH 探活上，而不是控制台的 /api/service/dsh/restart ─────
// 桥接的 checkDsh（src/bridge.js，5 秒一轮）在 DSH 从不可用变可用时会走
// `dshReady: false → true` 跃迁。无论重启是控制台按钮、手动 taskkill、还是桥接
// 自己重启后发现 DSH 已在线，都会经过这个跃迁，覆盖面比控制台 restart 分支大。
// 控制台 restart 之后 DSH 一定先 down 再 up，所以同样会被这条钩子捕获。
//
// ── 鉴权 ───────────────────────────────────────────────────────────────────
// `/sidebar/api/*` 走 DSH 的 connection fence（403 就是没通过），需要浏览器会话
// Cookie。这里用本机持久化签名密钥离线铸造（与 src/dsh-client.js 同一条路，
// 不依赖进程启动 token，也不会把任何密钥写进日志）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverDshSessionCookie } from './dsh-client.js';

/** 触发注册的接口：dsh-better-sidebar 的 settings.get（POST，body 为空对象）。 */
export const SIDEBAR_SETTINGS_METHOD = 'settings.get';
export const SIDEBAR_SETTINGS_PATH = `/sidebar/api/${SIDEBAR_SETTINGS_METHOD}`;

/** 最近一次预热结果（state/sidebar-warm.json），便于控制台/验证脚本直接看。 */
const DEFAULT_STATUS_FILE = fileURLToPath(new URL('../state/sidebar-warm.json', import.meta.url));
const STATUS_FILE_ENV = 'QQ_SIDEBAR_WARM_STATUS';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function statusFile() {
  return process.env[STATUS_FILE_ENV]
    ? path.resolve(process.env[STATUS_FILE_ENV])
    : DEFAULT_STATUS_FILE;
}

function writeStatusFile(result) {
  try {
    const file = statusFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // 状态文件只是诊断，写不进去不能影响主流程
  }
}

function normalizeBaseUrl(baseUrl) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('DSH baseUrl 为空，无法自动触发 sidebar 设置读取');
  return base;
}

/**
 * 调一次 `POST /sidebar/api/settings.get`。
 *
 * @param baseUrl - DSH 基址（例如 http://127.0.0.1:3080）。
 * @param options.cookie - 显式 Cookie（测试用）；缺省用本机签名密钥离线铸造。
 * @param options.timeoutMs - 单次请求超时。
 * @returns {Promise<{ok:boolean,status:number,prefs?:object,error?:string,retryable?:boolean}>}
 *   - ok=true 表示 HTTP 200 且响应体 ok:true 且拿到了设置值（注册闸门已执行）。
 *   - prefs 缺失（`{ value: undefined }`）表示插件的 settingsFace 还没建立，
 *     调用方应稍后重试；401/403 属于鉴权问题，重试没有意义（retryable=false）。
 */
export async function callSidebarSettingsGet(baseUrl, { timeoutMs = 4000, cookie = '' } = {}) {
  let base;
  try {
    base = normalizeBaseUrl(baseUrl);
  } catch (error) {
    return { ok: false, status: 0, error: error?.message ?? String(error), retryable: false };
  }
  let auth = cookie;
  if (!auth) {
    try {
      auth = discoverDshSessionCookie(base);
    } catch {
      auth = '';
    }
  }
  if (!auth) {
    return {
      ok: false,
      status: 0,
      error: '没有可用的 DSH 会话 Cookie（~/.dsh/.credentials.yaml 缺少 client-connection/browser-session 签名密钥）',
      retryable: false,
    };
  }
  try {
    const response = await fetch(base + SIDEBAR_SETTINGS_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: auth },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    let body = null;
    try { body = JSON.parse(raw); } catch { /* 非 JSON 时按原始文本报错 */ }
    if (response.status !== 200) {
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}：${raw.slice(0, 200)}`,
        retryable: !(response.status === 401 || response.status === 403),
      };
    }
    if (body?.ok !== true) {
      return { ok: false, status: response.status, error: `响应不是 ok:true：${raw.slice(0, 200)}`, retryable: true };
    }
    // 响应形状：{ ok:true, value:{ value:<侧卡片设置>, revision, externalDisable } }
    const prefs = body?.value?.value;
    if (prefs === undefined || prefs === null) {
      // settingsFace 还没建立（loader 未 settle / 无 settings 服务）——这条请求没有
      // 触发 syncOpenToolsGate，必须重试。
      return {
        ok: false,
        status: response.status,
        error: 'settings.get 返回 value=undefined（sidebar 插件的 settingsFace 尚未建立）',
        retryable: true,
      };
    }
    return { ok: true, status: response.status, prefs };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message ?? String(error), retryable: true };
  }
}

/**
 * DSH 就绪后自动触发 sidebar 设置读取，让 `sidebar_open` 被注册。
 *
 * 失败不抛错（调用方是桥接的探活循环，不能因为侧栏插件异常就卡住消息投递）；
 * 结果会写 `state/sidebar-warm.json` 并交给 log 输出。
 *
 * @param baseUrl - DSH 基址。
 * @param options.log - 日志函数（缺省不输出）。
 * @param options.attempts - 最多尝试次数（DSH 刚起来时路由可能还没挂上）。
 * @param options.intervalMs - 两次尝试的间隔。
 * @param options.timeoutMs - 单次请求超时。
 * @param options.cookie - 显式 Cookie（测试用）。
 * @returns {Promise<{ok:boolean,status:number,attempts:number,elapsedMs:number,agentOpenTools?:boolean,error?:string}>}
 */
export async function warmSidebarToolRegistration(baseUrl, {
  log = () => {},
  attempts = 3,
  intervalMs = 1200,
  timeoutMs = 4000,
  cookie = '',
} = {}) {
  const startedAt = Date.now();
  const total = Math.max(1, Number(attempts) || 1);
  let last = { ok: false, status: 0, error: '未执行' };
  let used = 0;
  for (let i = 1; i <= total; i += 1) {
    used = i;
    // eslint-disable-next-line no-await-in-loop -- 顺序重试，避免 DSH 启动瞬间并发打满
    last = await callSidebarSettingsGet(baseUrl, { timeoutMs, cookie });
    if (last.ok) break;
    if (last.retryable === false) break;
    if (i < total) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(intervalMs);
    }
  }
  const result = {
    at: new Date().toISOString(),
    baseUrl: String(baseUrl ?? ''),
    ok: last.ok === true,
    status: last.status ?? 0,
    attempts: used,
    elapsedMs: Date.now() - startedAt,
    agentOpenTools: last.ok ? last.prefs?.agentOpenTools === true : undefined,
    error: last.ok ? undefined : (last.error ?? '未知原因'),
  };
  writeStatusFile(result);
  if (result.ok) {
    log(`[sidebar] 已自动触发 ${SIDEBAR_SETTINGS_METHOD}（第 ${used} 次，${result.elapsedMs}ms）：`
      + `sidebar_open 注册闸门 agentOpenTools=${result.agentOpenTools === true ? 'true' : 'false'}`);
  } else {
    log(`⚠️ [sidebar] 自动触发 ${SIDEBAR_SETTINGS_METHOD} 失败（共 ${used} 次，${result.elapsedMs}ms）：${result.error}`);
  }
  return result;
}
