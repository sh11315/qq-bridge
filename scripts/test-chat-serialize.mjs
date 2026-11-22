#!/usr/bin/env node
// 普通 chat 串行锁回归：同一会话按提交顺序执行，失败不阻塞后续，不同会话互不影响。
// 用法：node scripts/test-chat-serialize.mjs
import assert from 'node:assert';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

const h = await bridgeHarness();
try {
  await test('同一 key 严格按提交顺序执行', async () => {
    const order = [];
    const first = h.queueChatPrompt('group:1', async () => {
      order.push('a-start');
      await sleep(80);
      order.push('a-end');
    });
    const second = h.queueChatPrompt('group:1', async () => {
      order.push('b-start');
      await sleep(20);
      order.push('b-end');
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  });

  await test('前一条失败不阻塞后续', async () => {
    let after = false;
    const failing = h.queueChatPrompt('group:2', async () => {
      throw new Error('fixture failure');
    });
    const following = h.queueChatPrompt('group:2', async () => {
      after = true;
    });
    await assert.rejects(() => failing, /fixture failure/);
    await following;
    assert.equal(after, true);
  });

  await test('不同 key 互不阻塞（各自都能完成）', async () => {
    const done = [];
    const slow = h.queueChatPrompt('group:3', async () => {
      await sleep(80);
      done.push('slow');
    });
    const fast = h.queueChatPrompt('group:4', async () => {
      done.push('fast');
    });
    await Promise.all([slow, fast]);
    assert.ok(done.includes('fast') && done.includes('slow'));
  });

  await test('配置开关默认关闭（chatSerialize=false）', async () => {
    assert.notEqual(h.cfg?.socialV2?.delivery?.chatSerialize, true, '默认不应改变现有 chat 时序');
  });
} finally {
  await h.close();
}

console.log(failed ? `\n${failed} 个用例失败` : '\n全部 chat 串行锁用例通过');
process.exit(failed ? 1 : 0);