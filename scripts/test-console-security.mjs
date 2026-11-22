// 控制台鉴权原语（src/console-auth.js）的离线单测。
// 7788 此前没有 Host 校验 / CSP / 统一 token；这里把安全水位钉成纯函数断言，
// 任何一次「顺手改回去」都会在 test:audit 里红。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONSOLE_COOKIE,
  CONSOLE_CSP,
  isAllowedLoopbackHost,
  parseCookie,
  sessionCookie,
  tokenFromRequest,
  tokensMatch,
} from '../src/console-auth.js';

test('token 定长比较：等值才放行，空值/长度差/大小写差一律失败', () => {
  assert.equal(tokensMatch('abc123', 'abc123'), true);
  assert.equal(tokensMatch('abc124', 'abc123'), false);
  assert.equal(tokensMatch('ABC123', 'abc123'), false);
  assert.equal(tokensMatch('abc12', 'abc123'), false);
  assert.equal(tokensMatch('', ''), false);
  assert.equal(tokensMatch(undefined, 'abc123'), false);
  assert.equal(tokensMatch('abc123', undefined), false);
  // 非字符串（?token= 解析出的永远字符串，但 header 可能被测试塞成数字）不得抛异常
  assert.equal(tokensMatch(123, '123'), true);
});

test('Host 白名单只认回环 + 实际端口', () => {
  assert.equal(isAllowedLoopbackHost('127.0.0.1:7788', 7788), true);
  assert.equal(isAllowedLoopbackHost('localhost:7788', 7788), true);
  assert.equal(isAllowedLoopbackHost('[::1]:7788', 7788), true);
  assert.equal(isAllowedLoopbackHost('127.0.0.1:7788', 7789), false);
  assert.equal(isAllowedLoopbackHost('evil.com:7788', 7788), false);
  assert.equal(isAllowedLoopbackHost('127.0.0.1', 7788), false);
  assert.equal(isAllowedLoopbackHost('', 7788), false);
  assert.equal(isAllowedLoopbackHost('127.0.0.1:7788', 0), false);
});

test('Cookie 解析：同名取值、URL 解码、坏值不抛', () => {
  const header = `a=1; ${CONSOLE_COOKIE}=tok%2Ben; z=9`;
  assert.equal(parseCookie(header), 'tok+en');
  assert.equal(parseCookie(`x=${CONSOLE_COOKIE}`), '');
  assert.equal(parseCookie(''), '');
  assert.equal(parseCookie(undefined), '');
  assert.equal(parseCookie(`${CONSOLE_COOKIE}=100%ZZ`), '100%ZZ');
});

test('token 来源优先级：query > header > cookie', () => {
  const url = new URL('http://127.0.0.1:7788/?token=from-query');
  const req = { headers: { 'x-console-token': 'from-header', cookie: `${CONSOLE_COOKIE}=from-cookie` } };
  assert.equal(tokenFromRequest(req, url), 'from-query');
  assert.equal(tokenFromRequest({ headers: req.headers }, new URL('http://127.0.0.1:7788/')), 'from-header');
  assert.equal(tokenFromRequest({ headers: { cookie: `${CONSOLE_COOKIE}=from-cookie` } }, new URL('http://127.0.0.1:7788/')), 'from-cookie');
  assert.equal(tokenFromRequest({ headers: {} }, new URL('http://127.0.0.1:7788/')), '');
});

test('Set-Cookie：HttpOnly / SameSite=Strict / Path=/ / Max-Age', () => {
  const cookie = sessionCookie('a b+c', 3600);
  assert.ok(cookie.startsWith(`${CONSOLE_COOKIE}=`));
  assert.ok(cookie.includes('Path=/'));
  assert.ok(cookie.includes('Max-Age=3600'));
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('SameSite=Strict'));
  assert.ok(cookie.includes('a%20b%2Bc'));
});

test('CSP 至少挡住外部脚本、对象、点击劫持与 base 改写', () => {
  assert.ok(CONSOLE_CSP.includes("script-src 'self'"));
  assert.ok(CONSOLE_CSP.includes("object-src 'none'"));
  assert.ok(CONSOLE_CSP.includes("frame-ancestors 'none'"));
  assert.ok(CONSOLE_CSP.includes("base-uri 'none'"));
  assert.ok(CONSOLE_CSP.includes("form-action 'self'"));
  assert.ok(CONSOLE_CSP.includes('img-src'));
});
