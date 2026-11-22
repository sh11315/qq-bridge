#!/usr/bin/env node
// 秘书旁路纯逻辑回归：咨询条件、消息摘要、请求构造、判定解析（fail-open）。
// 用法：node scripts/test-secretary.mjs
import assert from 'node:assert';
import {
  normalizeSecretaryConfig,
  shouldConsult,
  buildSecretaryDigest,
  buildSecretaryRequest,
  parseSecretaryVerdict,
  SECRETARY_PROMPT
} from '../src/core/secretary.mjs';

let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
};

await test('配置归一：默认关闭、未知值回退、数值夹取', () => {
  const cfg = normalizeSecretaryConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.maxCallsPerHour, 120);
  assert.equal(normalizeSecretaryConfig({ timeoutMs: 1 }).timeoutMs, 3000);
  assert.equal(normalizeSecretaryConfig({ maxCallsPerHour: 99999 }).maxCallsPerHour, 2000);
});

await test('咨询条件：关闭/点名/私聊/无未读都不咨询', () => {
  assert.equal(shouldConsult({ enabled: false, directWake: false, key: 'group:1', hasUnread: true }).consult, false);
  assert.equal(shouldConsult({ enabled: true, directWake: true, key: 'group:1', hasUnread: true }).consult, false);
  assert.equal(shouldConsult({ enabled: true, directWake: false, key: 'private:1', hasUnread: true }).consult, false);
  assert.equal(shouldConsult({ enabled: true, directWake: false, key: 'group:1', hasUnread: false }).consult, false);
  assert.equal(shouldConsult({ enabled: true, directWake: false, key: 'group:1', hasUnread: true }).consult, true);
});

await test('摘要：最多 8 条、截断 80 字、自己显示“我”', () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({
    sender: `群友${i}`,
    text: `第${i}条 ` + 'x'.repeat(200),
    isSelf: i === 11
  }));
  const digest = buildSecretaryDigest(messages);
  assert.equal(digest.split('\n').length, 8);
  assert.match(digest, /我：/);
  assert.ok(digest.split('\n').every((line) => line.length <= 90));
});

await test('请求：URL 与 system 规则、唤醒原因都带上', () => {
  const cfg = normalizeSecretaryConfig({ enabled: true, baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'cheap' });
  const { url, init } = buildSecretaryRequest({ messages: [{ sender: '小明', text: '在吗' }], reason: 'question' }, cfg);
  assert.equal(url, 'https://api.example/v1/chat/completions');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'cheap');
  assert.equal(body.messages[0].content, SECRETARY_PROMPT);
  assert.match(body.messages[1].content, /question/);
  assert.match(body.messages[1].content, /小明/);
});

await test('判定解析：reply / allow / 失败默认放行', () => {
  assert.deepEqual(parseSecretaryVerdict('{"reply":false,"reason":"灌水"}'), { allow: false, reason: '灌水' });
  assert.equal(parseSecretaryVerdict('```json\n{"reply":true,"reason":"提问"}\n```').allow, true);
  assert.equal(parseSecretaryVerdict('{"allow":false}').allow, false);
  const bad = parseSecretaryVerdict('not json');
  assert.equal(bad.allow, true);
  assert.equal(bad.fallback, true);
  assert.equal(parseSecretaryVerdict('{"reason":"x"}').allow, true, '缺字段必须放行');
});

console.log(failed ? `\n${failed} 个用例失败` : '\n全部秘书旁路用例通过');
process.exit(failed ? 1 : 0);