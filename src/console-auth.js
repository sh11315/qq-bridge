// 控制台（7788）与桥接（3100）共用的鉴权原语。
//
// 背景：7788 此前只监听 127.0.0.1，没有任何 Host 校验、CSP 或统一 token 门禁；
// 浏览器里的任意网页都可以借 DNS rebinding / 表单跨站触发写接口。桥接 3100 已经
// 有 Host 白名单与定长比较，这里把同一套水位抽成纯函数，供两个进程复用。
//
// 这个模块只做「判断」，不读文件、不起服务，便于 test-console-security.mjs 单测。
import crypto from 'node:crypto';

/** HttpOnly cookie 名：浏览器打开 7788 后自动携带，省掉每个 fetch 手写 token。 */
export const CONSOLE_COOKIE = 'qqb_console_token';
/** cookie 有效期：7 天；本机控制台，不追求长期会话。 */
export const CONSOLE_COOKIE_MAX_AGE_SEC = 7 * 24 * 60 * 60;

/**
 * 定长比较：`!==` 会在第一个不同字符处短路，理论上可被本机进程用响应时延逐字节试探。
 * 空令牌一律失败（fail-closed）；长度不同直接 false，不调用 timingSafeEqual（它要求等长）。
 */
export function tokensMatch(supplied, expected) {
  const a = Buffer.from(String(supplied ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 从 Cookie 头里取指定 cookie；值按 encodeURIComponent 解码，坏值原样返回。 */
export function parseCookie(header, name = CONSOLE_COOKIE) {
  if (typeof header !== 'string' || !header) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return '';
}

/**
 * 控制台 token 的三个来源，优先级：query（首次打开 /?token=）> header（脚本/qq-admin）
 * > cookie（浏览器后续请求）。返回第一个非空值，绝不把 undefined 变成字符串 "undefined"。
 */
export function tokenFromRequest(req, url) {
  const query = url?.searchParams?.get('token');
  if (query) return String(query);
  const header = req?.headers?.['x-console-token'];
  if (header) return String(header);
  const cookie = parseCookie(req?.headers?.cookie);
  return cookie || '';
}

/**
 * Host 白名单（DNS rebinding 硬化）：只接受 127.0.0.1 / localhost / [::1] + 实际绑定端口。
 * 用 server.address().port 而不是配置端口：测试用 --port 0 时配置里是 0。
 */
export function isAllowedLoopbackHost(host, port) {
  const expected = Number(port);
  if (!Number.isInteger(expected) || expected <= 0) return false;
  if (typeof host !== 'string') return false;
  const lower = host.trim().toLowerCase();
  return lower === `127.0.0.1:${expected}`
    || lower === `localhost:${expected}`
    || lower === `[::1]:${expected}`;
}

/** Set-Cookie 值：HttpOnly（JS 读不到）+ SameSite=Strict（跨站不带）+ Path=/。 */
export function sessionCookie(token, maxAgeSec = CONSOLE_COOKIE_MAX_AGE_SEC) {
  const value = encodeURIComponent(String(token ?? ''));
  const age = Math.max(0, Math.floor(Number(maxAgeSec) || 0));
  return `${CONSOLE_COOKIE}=${value}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Strict`;
}

/**
 * 控制台页面的 CSP。保留 'unsafe-inline'：ui.html 有大量内联事件/样式；
 * 但禁止 object/base/frame，图片与媒体只放本机、data/blob 和 https（QQ 头像）。
 * 这不是「零 inline」的严格 CSP，而是先挡住外部脚本与点击劫持。
 */
export const CONSOLE_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  // 控制台自己会用同源 iframe 嵌「记忆银河 / 记忆网络」页面；
  // 只放同源，仍然禁止第三方站点嵌套或加载外部 frame。
  "frame-ancestors 'self'",
  "frame-src 'self'",
  "form-action 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
].join('; ');
