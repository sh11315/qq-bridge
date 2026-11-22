#!/usr/bin/env node
// DSH 事件契约监控回归：已知/未知计数、窗口摘要、未知样本上限、格式化。
// 用法：node scripts/test-dsh-event-monitor.mjs
import assert from 'node:assert';
import {
  createDshEventMonitor,
  isKnownDshEventType,
  DEFAULT_EVENT_SUMMARY_MS
} from '../src/core/dsh-event-monitor.mjs';

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

await test('已知/未知判定：step/start 属于已知，新事件名属于未知', () => {
  assert.equal(isKnownDshEventType('turn/end'), true);
  assert.equal(isKnownDshEventType('step/start'), true);
  assert.equal(isKnownDshEventType('session-log-deepseek/delivery-accepted'), true);
  assert.equal(isKnownDshEventType('model/selection'), true);
  assert.equal(isKnownDshEventType('command/run'), true);
  assert.equal(isKnownDshEventType('subagent/catalog'), true);
  assert.equal(isKnownDshEventType('agent/inbox/spliced'), true);
  assert.equal(isKnownDshEventType('brand/new-event'), false);
  assert.equal(isKnownDshEventType(''), false);
});

await test('窗口到期返回摘要并重置', () => {
  let clock = 1000;
  const monitor = createDshEventMonitor({ windowMs: 60000, now: () => clock });
  assert.equal(monitor.record('turn/end'), null);
  monitor.record('turn/end');
  monitor.record('assistant/message');
  clock += 60000;
  const summary = monitor.record('brand/new-event');
  assert.ok(summary, '到期应返回摘要');
  assert.equal(summary.windowMs, 60000);
  assert.equal(summary.counts['turn/end'], 2);
  assert.equal(summary.counts['brand/new-event'], 1);
  assert.equal(summary.unknown['brand/new-event'], 1);
  assert.equal(summary.total, 4);
  // 重置后：再记录不应把旧计数带进来
  clock += 1000;
  const next = monitor.record('turn/end');
  assert.equal(next, null);
  assert.equal(monitor.flush().counts['turn/end'], 1);
});

await test('未知样本最多保留 maxUnknown 个', () => {
  let clock = 0;
  const monitor = createDshEventMonitor({ windowMs: 0, now: () => clock, maxUnknown: 2 });
  monitor.record('a/new');
  monitor.record('b/new');
  monitor.record('c/new');
  const summary = monitor.flush();
  assert.deepEqual(Object.keys(summary.unknown).sort(), ['a/new', 'b/new']);
});

await test('未知类型达到采样上限后，已采样类型仍继续累加', () => {
  const monitor = createDshEventMonitor({ windowMs: 0, now: () => 0, maxUnknown: 2 });
  for (const type of ['a/new', 'a/new', 'a/new', 'b/new', 'c/new', 'a/new']) monitor.record(type);
  const summary = monitor.flush();
  // 采样上限只限制「记录哪些未知类型」。若它连带冻结计数，日志会把 4 次漂移
  // 显示成 ×3，把最该被看见的信号压成噪声。
  assert.equal(summary.unknown['a/new'], 4, '已采样的未知类型每次出现都必须累加');
  assert.equal(summary.unknown['b/new'], 1);
  assert.equal(summary.unknown['c/new'], undefined, '超出上限的新类型不再采样');
  assert.equal(summary.counts['a/new'], 4);
});

await test('格式化摘要包含窗口、总数、未知项', () => {
  let clock = 0;
  const monitor = createDshEventMonitor({ windowMs: 60000, now: () => clock });
  monitor.record('turn/end');
  monitor.record('brand/new-event');
  clock += 60000;
  const summary = monitor.record('assistant/message');
  const text = monitor.format(summary);
  assert.match(text, /60s 3 条/);
  assert.match(text, /turn\/end=1/);
  assert.match(text, /未知：brand\/new-event×1/);
});

await test('windowMs=0 时不自动 flush（交给调用方 flush）', () => {
  let clock = 0;
  const monitor = createDshEventMonitor({ windowMs: 0, now: () => clock });
  clock += 10 * 60000;
  assert.equal(monitor.record('turn/end'), null);
  assert.ok(monitor.flush());
});

await test('默认窗口是 60 秒', () => {
  assert.equal(DEFAULT_EVENT_SUMMARY_MS, 60000);
});

console.log(failed ? `\n${failed} 个用例失败` : '\n全部 DSH 事件监控用例通过');
process.exit(failed ? 1 : 0);