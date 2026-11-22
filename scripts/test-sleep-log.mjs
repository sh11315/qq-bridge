/**
 * 睡觉模块测试：判定 / 落盘 / 统计 / 早上由头。
 * 跑法：node scripts/test-sleep-log.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  detectSleepSignal,
  parseSleepLog,
  readSleepLog,
  appendSleepEntry,
  sleepStats,
  buildWakeCue,
  SLEEP_LOG_MAX_LINES,
} from '../src/core/sleep-log.mjs';

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}: ${error?.message ?? error}`);
  }
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-log-'));
const HOUR = 60 * 60 * 1000;

console.log('睡觉模块');

check('detectSleepSignal 认睡觉的那几句', () => {
  for (const text of ['睡了', '我先睡了', '睡觉了', '去睡了晚安', '好累 睡了', '晚安啦', '睡觉去']) {
    assert.equal(detectSleepSignal(text), 'sleep', text);
  }
});

check('detectSleepSignal 不把「睡醒/你醒了吗」当睡了', () => {
  for (const text of ['睡醒了', '你睡了吗', '午饭吃了吗', '刚睡醒哈哈']) {
    assert.notEqual(detectSleepSignal(text), 'sleep', text);
  }
});

check('detectSleepSignal 认醒来信号，且只认句首', () => {
  assert.equal(detectSleepSignal('醒了'), 'wake');
  assert.equal(detectSleepSignal('刚起了'), 'wake');
  assert.equal(detectSleepSignal('我睡醒了'), 'wake');
  assert.equal(detectSleepSignal('你怎么才醒'), '');
});

check('parseSleepLog 丢坏行、按时间排序', () => {
  const text = [
    '{"at":2000,"kind":"wake","text":"醒了"}',
    'not json',
    '',
    '{"at":1000,"kind":"sleep","text":"睡了"}',
    '{"at":1500,"kind":"oops"}',
  ].join('\n');
  const list = parseSleepLog(text);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((e) => e.kind), ['sleep', 'wake']);
});

check('appendSleepEntry 落盘可读、坏入参不写', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sleep-log.jsonl');
  assert.equal(appendSleepEntry(file, { at: 1000, kind: 'sleep', text: '睡了' }), true);
  assert.equal(appendSleepEntry(file, { at: 2000, kind: 'wake', text: '醒了' }), true);
  assert.equal(appendSleepEntry(file, { at: 0, kind: 'sleep' }), false);
  assert.equal(appendSleepEntry(file, { at: 3000, kind: 'nap' }), false);
  const list = readSleepLog(file);
  assert.equal(list.length, 2);
  assert.equal(list[1].kind, 'wake');
  assert.equal(readSleepLog(path.join(dir, 'missing.jsonl')).length, 0);
});

check('appendSleepEntry 超过上限会压掉最旧的行', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sleep-log.jsonl');
  const bulk = [];
  for (let i = 0; i < SLEEP_LOG_MAX_LINES + 250; i += 1) {
    bulk.push(JSON.stringify({ at: 1000 + i, kind: i % 2 ? 'wake' : 'sleep', text: '' }));
  }
  fs.writeFileSync(file, `${bulk.join('\n')}\n`, 'utf8');
  assert.equal(appendSleepEntry(file, { at: 999999, kind: 'wake', text: '醒了' }), true);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length <= SLEEP_LOG_MAX_LINES, `压行后仍有 ${lines.length} 行`);
});

check('sleepStats 判断是否还在睡、睡了多久', () => {
  const now = 100 * HOUR;
  const asleep = sleepStats([
    { at: now - 9 * HOUR, kind: 'sleep' },
    { at: now - 30 * HOUR, kind: 'wake' },
  ], now);
  assert.equal(asleep.asleep, true);
  assert.equal(asleep.asleepMs, 9 * HOUR);

  const awake = sleepStats([
    { at: now - 9 * HOUR, kind: 'sleep' },
    { at: now - 2 * HOUR, kind: 'wake' },
  ], now);
  assert.equal(awake.asleep, false);
  assert.equal(awake.asleepMs, 0);

  assert.deepEqual(sleepStats([], now), { lastSleepAt: 0, lastWakeAt: 0, asleep: false, asleepMs: 0 });
});

check('buildWakeCue 只在早上、且睡够 4 小时时给由头', () => {
  const morning = new Date(2026, 9, 31, 8, 30, 0, 0); // 10-31 08:30 本地时间
  const asleep = { lastSleepAt: morning.getTime() - 7 * HOUR, asleep: true, asleepMs: 7 * HOUR, lastWakeAt: 0 };
  const cue = buildWakeCue(asleep, morning.getTime());
  assert.ok(cue, '早上该有由头');
  assert.equal(cue.kind, 'sleep');
  assert.equal(cue.id, 'sleep-wake-2026-10-31');
  assert.match(cue.text, /7 小时/);
  assert.ok(cue.windowMinutes > 0);

  const tooShort = { ...asleep, asleepMs: 2 * HOUR };
  assert.equal(buildWakeCue(tooShort, morning.getTime()), null, '才睡 2 小时不该吵他');

  const noon = new Date(2026, 9, 31, 13, 0, 0, 0);
  assert.equal(buildWakeCue(asleep, noon.getTime()), null, '下午不该再问早上');

  assert.equal(buildWakeCue({ ...asleep, asleep: false }, morning.getTime()), null);
});

if (failures.length) {
  console.error(`\n失败 ${failures.length} 项：`);
  for (const { name, error } of failures) console.error(`- ${name}: ${error?.stack ?? error}`);
  process.exit(1);
}
console.log(`\n${passed} 项全过`);
