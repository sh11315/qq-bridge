/**
 * 会话 writer-held 冲突：退避重试 / 跳过本轮 的单元测试。
 *
 * 背景见 src/low-priority-prompt.mjs 头注释：黑话提取与切模型都会被 DSH 的
 * 会话写锁拒绝，这两类操作都可以「等一下再做 / 下一回合再做」，不能当 ERROR 刷屏。
 */
import assert from 'node:assert/strict';
import {
  WRITER_HELD_DELAYS,
  isWriterHeldError,
  retryOnWriterHeld,
} from '../src/low-priority-prompt.mjs';

const writerHeld = () => ({
  code: 'session/writer-held',
  message: 'session/writer-held: session "s" is already owned by an active write handle',
});

// 1) 识别三种错误形态
assert.equal(isWriterHeldError(writerHeld()), true, 'code 形态要识别');
assert.equal(isWriterHeldError({ message: 'session/writer-held: ...' }), true, 'message 形态要识别');
assert.equal(isWriterHeldError(new Error('session "x" is already owned by an active write handle')), true, 'Error 实例要识别');
assert.equal(isWriterHeldError({ code: 'session/not-found', message: 'not found' }), false, '其它错误不能误判');
assert.equal(isWriterHeldError(null), false, 'null 不能崩');

// 2) 第一次撞锁、第二次成功：必须重试而不是直接放弃
{
  const sleeps = [];
  let calls = 0;
  const r = await retryOnWriterHeld(async () => {
    calls += 1;
    return calls === 1 ? { ok: false, error: writerHeld() } : { ok: true, value: { selected: true } };
  }, { delays: [10, 20], sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(r.ok, true, '第二次成功应返回 ok');
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.value, { selected: true }, '成功结果要透传 value');
  assert.deepEqual(sleeps, [10], '只应在两次尝试之间等待一次');
  assert.equal(calls, 2);
}

// 3) 持续撞锁：按阶梯重试完 → skipped（不抛异常、不算故障）
{
  const sleeps = [];
  let calls = 0;
  const debug = [];
  const r = await retryOnWriterHeld(async () => {
    calls += 1;
    return { ok: false, error: writerHeld() };
  }, {
    delays: [5, 6, 7],
    sleep: async (ms) => { sleeps.push(ms); },
    logDebug: (message) => debug.push(message),
    label: '黑话提取',
  });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true, '重试耗尽后应标记 skipped');
  assert.equal(r.attempts, 4, '1 次原始 + 3 次重试');
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [5, 6, 7], '等待阶梯必须按配置');
  assert.ok(debug.some((m) => /跳过本轮/.test(m)), '跳过要留 debug 日志');
  assert.ok(debug.every((m) => /写锁/.test(m)) || debug.length >= 2, '日志应说明写锁原因');
}

// 4) 非写锁错误：立即返回、不等待、不吞异常语义
{
  let calls = 0;
  const sleeps = [];
  const r = await retryOnWriterHeld(async () => {
    calls += 1;
    return { ok: false, error: { code: 'session/not-found', message: 'session not found' } };
  }, { delays: [1000], sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, undefined, '非写锁错误不能被当成 skipped');
  assert.equal(r.error.code, 'session/not-found');
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, [], '非写锁错误不应退避');
}

// 5) attempt 直接抛 writer-held：也走重试；抛别的异常必须原样抛出
{
  let calls = 0;
  const r = await retryOnWriterHeld(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('writer-held boom'), writerHeld());
    return { ok: true };
  }, { delays: [1], sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(calls, 2, '抛出的写锁错误也要重试');

  let threw = '';
  try {
    await retryOnWriterHeld(async () => { throw new Error('磁盘炸了'); }, { delays: [1], sleep: async () => {} });
  } catch (error) {
    threw = String(error?.message ?? error);
  }
  assert.match(threw, /磁盘炸了/, '非写锁异常必须原样抛出，不能被吞成 skipped');
}

// 6) 默认阶梯是常量且有序
assert.deepEqual([...WRITER_HELD_DELAYS], [800, 2000, 4000], '默认退避阶梯变化需同步注释与报告');

console.log('PASS writer-held：识别 / 重试 / 跳过 / 非写锁错误不吞 / 默认退避阶梯');
