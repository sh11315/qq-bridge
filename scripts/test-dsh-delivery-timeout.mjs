#!/usr/bin/env node
// DSH 投递超时回归：prompt 永不返回时按失败收尾、不重投、不拖住队列。
// 用法：node scripts/test-dsh-delivery-timeout.mjs
import assert from 'node:assert';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
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

await test('sessions.prompt 卡住时按超时失败，且不重投', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message(KEY, '小明', '测试消息', '测试消息', false, false, 'm1', [], '2001', [], '');
    h.cfg.socialV2.delivery = { promptTimeoutMs: 1000 };
    h.api.sessions.prompt = async (params) => {
      h.calls.prompts.push(params);
      return new Promise(() => {});
    };
    const started = Date.now();
    await assert.rejects(() => h.deliverPrompt(KEY, '测试投递', { wakeReason: 'question' }), /超时/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 5000, `应在约 1s 超时，实际 ${elapsed}ms`);
    assert.equal(h.calls.prompts.length, 1, '超时不应自动重投');
    assert.equal(h.promptQueues.get(KEY)?.running ?? false, false, '队列必须释放 running，否则会话永久繁忙');
  } finally {
    await h.close();
  }
});

await test('超时后同一会话的下一条投递仍可执行（队列不被卡死）', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message(KEY, '小明', '测试消息', '测试消息', false, false, 'm1', [], '2001', [], '');
    h.cfg.socialV2.delivery = { promptTimeoutMs: 500 };
    let calls = 0;
    h.api.sessions.prompt = async (params) => {
      calls += 1;
      h.calls.prompts.push(params);
      if (calls === 1) return new Promise(() => {});
      return { result: { ok: true, value: {} } };
    };
    await assert.rejects(() => h.deliverPrompt(KEY, '第一条', { wakeReason: 'question' }), /超时/);
    const second = await h.deliverPrompt(KEY, '第二条', { wakeReason: 'question' });
    assert.equal(second.ok, true, '超时后队列应能继续投递');
    assert.equal(calls, 2);
  } finally {
    await h.close();
  }
});

console.log(failed ? `\n${failed} 个用例失败` : '\n全部 DSH 投递超时用例通过');
process.exit(failed ? 1 : 0);