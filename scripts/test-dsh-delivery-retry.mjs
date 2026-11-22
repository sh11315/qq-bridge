#!/usr/bin/env node
// DSH 投递优化回归：主投递遇到 writer-held 写锁时，3s 后重投一次且不丢这一枪。
// 用法：node scripts/test-dsh-delivery-retry.mjs
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

await test('writer-held：首次被拒后 3s 重投一次，且不无限重试', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message(KEY, '小明', '测试消息', '测试消息', false, false, 'm1', [], '2001', [], '');
    let calls = 0;
    h.api.sessions.prompt = async (params) => {
      calls += 1;
      h.calls.prompts.push(params);
      if (calls === 1) {
        return { result: { ok: false, error: { code: 'session/writer-held', message: 'session "x" is already owned by an active write handle' } } };
      }
      return { result: { ok: true, value: {} } };
    };
    const first = await h.deliverPrompt(KEY, '测试投递', { wakeReason: 'question' });
    assert.equal(first.ok, true, '写锁应被视为“已安排重投”，不能回滚唤醒');
    assert.equal(first.retried, true);
    assert.equal(calls, 1);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    assert.equal(calls, 2, '3s 后应重投一次');
    assert.ok(JSON.stringify(h.calls.prompts[1] || {}).includes('测试'), '重投内容应包含原始文本');
  } finally {
    await h.close();
  }
});

await test('非写锁错误仍然按失败返回（不重投）', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message(KEY, '小明', '测试消息', '测试消息', false, false, 'm1', [], '2001', [], '');
    let calls = 0;
    h.api.sessions.prompt = async (params) => {
      calls += 1;
      h.calls.prompts.push(params);
      return { result: { ok: false, error: { code: 'FIXTURE_REJECT', message: 'fixture rejection' } } };
    };
    const result = await h.deliverPrompt(KEY, '测试投递', { wakeReason: 'question' });
    assert.equal(result.ok, false);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    assert.equal(calls, 1, '非写锁错误不应重投');
  } finally {
    await h.close();
  }
});

console.log(failed ? `\n${failed} 个用例失败` : '\n全部 DSH 投递重试用例通过');
process.exit(failed ? 1 : 0);