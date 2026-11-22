#!/usr/bin/env node
// scripts/test-memory-trial.mjs
// 覆盖 src/memory/wake-habit.mjs 纯函数 + scripts/memory-trial.mjs 运维脚本。
// 全部用临时目录，不碰真实 state/memory。
//
// 运行：node scripts/test-memory-trial.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  WAKE_HABIT_RULE,
  WAKE_LOG_MAX_LINES,
  normalizeWakeLog,
  appendWakeLogLine,
  parseWakeLog,
  wakeHabitPrompt,
} from '../src/memory/wake-habit.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'memory-trial.mjs');
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`not ok - ${name}`);
    console.log(`  ${error && error.message ? error.message : String(error)}`);
  }
}

const tmpDirs = [];
function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-trial-'));
  tmpDirs.push(dir);
  return dir;
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 120000,
    windowsHide: true,
    ...options,
  });
}

function parseCliJson(result) {
  assert.equal(result.status, 0, `CLI 退出码应为 0，实际 ${result.status}；stderr=${result.stderr}`);
  return JSON.parse(result.stdout);
}

// ---------------------------------------------------------------- 测试数据

function brainWithPinned(extra = {}) {
  return {
    memories: {
      mem_pin_a: {
        id: 'mem_pin_a',
        title: '主人的偏好',
        text: '喜欢简洁的回复',
        category: 'profile',
        status: 'active',
        strength: 0.9,
        protection: 1,
        lastActivatedAt: NOW - 5000,
      },
      mem_pin_b: {
        id: 'mem_pin_b',
        title: '管理员在开封',
        text: '管理员在开封（我就在开封）',
        category: 'relationship',
        status: 'active',
        strength: 0.9995,
        layer: 'L3',
        lastActivatedAt: NOW - 10000,
      },
      mem_rel: {
        id: 'mem_rel',
        title: '项目约定',
        text: '每周日做记忆维护',
        category: 'fact',
        status: 'active',
        strength: 0.7,
        lastActivatedAt: NOW - 20000,
      },
      mem_old: {
        id: 'mem_old',
        title: '旧事',
        text: '很久以前的事',
        category: 'fact',
        status: 'archived',
        strength: 0.1,
      },
    },
    state: { energy: 0.32, mood: 0.05, updatedAt: NOW },
    ...extra,
  };
}

function trialFixtureState({ withTrial = true, withBrain = true, withSelfReview = true } = {}) {
  const dir = path.join(makeTmp(), 'state');
  const memoryDir = path.join(dir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  if (withTrial) {
    writeJson(path.join(memoryDir, 'trial.json'), {
      startedAt: NOW - 2 * DAY_MS,
      durationDays: 30,
      probe: { text: '你在开封', baselineMemoryId: null },
      createdAt: NOW - 2 * DAY_MS,
    });
  }
  if (withBrain) {
    writeJson(
      path.join(memoryDir, 'brain.json'),
      brainWithPinned({
        self: {
          proposals: [
            { id: 'p1', title: '少用客套话', status: 'pending' },
            { id: 'p2', title: '多主动追问', status: 'approved' },
            { id: 'p3', title: '少发长段落', status: 'rejected' },
            { id: 'p4', title: '别急着总结', status: 'pending' },
          ],
        },
      }),
    );
  }
  const wakeEntries = [
    { at: NOW - 3000, key: 'group:1', sawPinned: true, sawRelated: true, sawEmotion: true, proactive: false, sent: true, replyLen: 30 },
    { at: NOW - 2000, key: 'group:1', sawPinned: true, sawRelated: false, sawEmotion: false, proactive: false, sent: true, replyLen: 50 },
    { at: NOW - 1000, key: 'group:1', sawPinned: false, sawRelated: true, sawEmotion: true, proactive: true, sent: false, replyLen: 70 },
  ];
  writeText(
    path.join(memoryDir, 'wake-log.jsonl'),
    `${wakeEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n不是JSON的坏行\n`,
  );
  if (withSelfReview) {
    writeJson(path.join(memoryDir, 'self-review.json'), {
      ok: true,
      scan: { total: 10 },
      proposals: [],
      drift: { avgLen: 42, serviceToneRate: 0.125, questionTailRate: 0.35 },
      selfScore: 82,
      externalScore: null,
    });
  }
  return { stateDir: dir, memoryDir };
}

// ---------------------------------------------------------------- wake-habit

check('WAKE_HABIT_RULE 文案固定', () => {
  assert.equal(
    WAKE_HABIT_RULE,
    '每次醒来先翻一遍【记忆·置顶】和【此刻情绪】再决定接不接话；不翻完不要开口。',
  );
});

check('normalizeWakeLog 空输入返回 8 个默认键', () => {
  assert.deepEqual(normalizeWakeLog(), {
    at: 0,
    key: '',
    sawPinned: false,
    sawRelated: false,
    sawEmotion: false,
    proactive: false,
    sent: false,
    replyLen: 0,
  });
  assert.deepEqual(normalizeWakeLog(null), normalizeWakeLog({}));
  assert.deepEqual(normalizeWakeLog([]), normalizeWakeLog({}));
  assert.deepEqual(normalizeWakeLog('不是 JSON'), normalizeWakeLog({}));
});

check('normalizeWakeLog 容错字符串/ISO 时间/布尔/取整', () => {
  const entry = normalizeWakeLog({
    at: '2026-10-29T00:00:00.000Z',
    key: ' group:1 ',
    sawPinned: 'true',
    sawRelated: 1,
    sawEmotion: true,
    proactive: '1',
    sent: 0,
    replyLen: '42.7',
    extra: 'should be dropped',
  });
  assert.deepEqual(entry, {
    at: Date.parse('2026-10-29T00:00:00.000Z'),
    key: 'group:1',
    sawPinned: true,
    sawRelated: true,
    sawEmotion: true,
    proactive: true,
    sent: false,
    replyLen: 43,
  });

  const fromJson = normalizeWakeLog(JSON.stringify({ at: 123, key: 'private:2', sent: true }));
  assert.equal(fromJson.at, 123);
  assert.equal(fromJson.key, 'private:2');
  assert.equal(fromJson.sent, true);
});

check('normalizeWakeLog 非法值落回缺省', () => {
  const entry = normalizeWakeLog({ at: 'nope', key: 123, replyLen: -5, sawPinned: 'nope' });
  assert.equal(entry.at, 0);
  assert.equal(entry.key, '123');
  assert.equal(entry.replyLen, 0);
  assert.equal(entry.sawPinned, false);
});

check('appendWakeLogLine 追加一行并可被 parseWakeLog 读回', () => {
  const lines = appendWakeLogLine([], {
    at: NOW,
    key: 'group:1',
    sawPinned: true,
    replyLen: 12,
  });
  assert.ok(Array.isArray(lines));
  assert.equal(lines.length, 1);
  const parsed = parseWakeLog(`${lines.join('\n')}\n`);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], normalizeWakeLog({ at: NOW, key: 'group:1', sawPinned: true, replyLen: 12 }));
});

check(`appendWakeLogLine 最多保留 ${WAKE_LOG_MAX_LINES} 行（丢最旧）`, () => {
  const full = Array.from({ length: WAKE_LOG_MAX_LINES }, (_, i) =>
    JSON.stringify(normalizeWakeLog({ at: i + 1 })),
  );
  const appended = appendWakeLogLine(full, { at: 99999999 });
  assert.equal(appended.length, WAKE_LOG_MAX_LINES);
  const parsed = parseWakeLog(`${appended.join('\n')}\n`);
  assert.equal(parsed.length, WAKE_LOG_MAX_LINES);
  assert.equal(parsed[0].at, 2);
  assert.equal(parsed[parsed.length - 1].at, 99999999);
});

check('appendWakeLogLine 兼容整段 JSONL 文本输入', () => {
  const lines = appendWakeLogLine('{"at":5}\n', { at: 6 });
  assert.equal(lines.length, 2);
  assert.deepEqual(
    parseWakeLog(lines.join('\n')).map((entry) => entry.at),
    [5, 6],
  );
});

check('parseWakeLog 跳过 BOM/空行/坏行/非对象行', () => {
  const text =
    `\uFEFF${JSON.stringify({ at: 111, key: 'k' })}\n\n` +
    `oops\n"string-line"\n[1,2]\nnull\n${JSON.stringify({ at: 222 })}\r\n`;
  const entries = parseWakeLog(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].at, 111);
  assert.equal(entries[0].key, 'k');
  assert.equal(entries[1].at, 222);
  assert.deepEqual(parseWakeLog(''), []);
  assert.deepEqual(parseWakeLog(null), []);
});

check('wakeHabitPrompt 空 brain 输出固定默认文案', () => {
  assert.equal(
    wakeHabitPrompt({}),
    '醒来先看记忆：现在有 0 条置顶（无）、0 条相关、此刻情绪：平静；看完再决定要不要开口。',
  );
  assert.equal(
    wakeHabitPrompt(),
    '醒来先看记忆：现在有 0 条置顶（无）、0 条相关、此刻情绪：平静；看完再决定要不要开口。',
  );
});

check('wakeHabitPrompt 统计置顶/相关并注入最新情绪', () => {
  const brain = brainWithPinned({
    emotions: [{ id: 'e1', label: '烦躁', intensity: 0.8, at: NOW - 1000 }],
  });
  assert.equal(
    wakeHabitPrompt({ brain, now: NOW }),
    '醒来先看记忆：现在有 2 条置顶（主人的偏好、管理员在开封）、1 条相关、此刻情绪：挺烦躁；看完再决定要不要开口。',
  );
});

check('wakeHabitPrompt 过期情绪回退到 mood 档位', () => {
  const brain = {
    memories: {},
    state: { mood: 0.2 },
    emotions: [{ label: '开心', intensity: 0.9, at: NOW - 2 * DAY_MS }],
  };
  assert.equal(
    wakeHabitPrompt({ brain, now: NOW }),
    '醒来先看记忆：现在有 0 条置顶（无）、0 条相关、此刻情绪：还不错；看完再决定要不要开口。',
  );
});

check('wakeHabitPrompt 传 anchors 时多一句「压底」，不传则原文案不变', () => {
  const brain = brainWithPinned({
    emotions: [{ id: 'e1', label: '烦躁', intensity: 0.8, at: NOW - 1000 }],
  });
  assert.equal(
    wakeHabitPrompt({ brain, now: NOW }),
    '醒来先看记忆：现在有 2 条置顶（主人的偏好、管理员在开封）、1 条相关、此刻情绪：挺烦躁；看完再决定要不要开口。',
  );
  assert.equal(
    wakeHabitPrompt({
      brain,
      now: NOW,
      anchors: [{ id: 'mem_rel', title: '项目约定' }, { id: 'mem_x', title: '猫条欠账' }],
    }),
    '醒来先看记忆：现在有 2 条置顶（主人的偏好、管理员在开封）、1 条相关，压底 2 条（项目约定、猫条欠账）、此刻情绪：挺烦躁；看完再决定要不要开口。',
  );
  // 空数组等价于不传，别让调用方多拼一个空括号。
  assert.equal(
    wakeHabitPrompt({ brain, now: NOW, anchors: [] }),
    '醒来先看记忆：现在有 2 条置顶（主人的偏好、管理员在开封）、1 条相关、此刻情绪：挺烦躁；看完再决定要不要开口。',
  );
});

check('wakeHabitPrompt 优先使用 brain.top 显式置顶', () => {
  const brain = {
    memories: {
      m1: { id: 'm1', title: '置顶A', permanent: true, status: 'active' },
      m2: { id: 'm2', title: '置顶B', tags: ['pinned'], status: 'active' },
      m3: { id: 'm3', title: '普通', status: 'active' },
    },
    top: ['m2'],
  };
  assert.equal(
    wakeHabitPrompt({ brain, now: NOW }),
    '醒来先看记忆：现在有 1 条置顶（置顶B）、1 条相关、此刻情绪：平静；看完再决定要不要开口。',
  );
});

check('wakeHabitPrompt 兼容 memories 数组与单条 brain.emotion', () => {
  const brain = {
    memories: [{ id: 'x', title: '甲', permanent: true, status: 'active' }],
    emotion: { label: '开心', intensity: 0.5, at: NOW - 500 },
  };
  assert.equal(
    wakeHabitPrompt({ brain, now: NOW }),
    '醒来先看记忆：现在有 1 条置顶（甲）、0 条相关、此刻情绪：有点开心；看完再决定要不要开口。',
  );
});

// ---------------------------------------------------------------- memory-trial CLI

check('--init 写 trial.json（默认 30 天，探针=你在开封）', () => {
  const state = path.join(makeTmp(), 'state');
  const result = runCli(['--state', state, '--init', '--json']);
  const payload = parseCliJson(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.reused, false);
  assert.equal(typeof payload.trial.startedAt, 'number');
  assert.equal(typeof payload.trial.createdAt, 'number');
  assert.equal(payload.trial.durationDays, 30);
  assert.deepEqual(payload.trial.probe, { text: '你在开封', baselineMemoryId: null });

  const file = path.join(state, 'memory', 'trial.json');
  assert.ok(fs.existsSync(file));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.durationDays, 30);
  assert.equal(saved.probe.text, '你在开封');
  assert.equal(saved.startedAt, payload.trial.startedAt);
  assert.equal(saved.createdAt, payload.trial.createdAt);
});

check('--init --days 7 写入自定义测试期', () => {
  const state = path.join(makeTmp(), 'state');
  const payload = parseCliJson(runCli(['--state', state, '--init', '--days', '7', '--json']));
  assert.equal(payload.trial.durationDays, 7);
});

check('重复 --init 沿用原测试期，不重置一个月观察', () => {
  const state = path.join(makeTmp(), 'state');
  const first = parseCliJson(runCli(['--state', state, '--init', '--json']));
  const second = parseCliJson(runCli(['--state', state, '--init', '--json']));
  assert.equal(second.reused, true);
  assert.equal(second.trial.startedAt, first.trial.startedAt);
});

check('--report 输出完整结构并写 trial-report.json', () => {
  const { stateDir, memoryDir } = trialFixtureState();
  const result = runCli(['--state', stateDir, '--report', '--json']);
  const report = parseCliJson(result);
  assert.deepEqual(Object.keys(report), [
    'ok',
    'at',
    'trial',
    'wakes',
    'emotionRecited',
    'proposals',
    'probe',
    'drift',
  ]);
  assert.equal(report.ok, true);
  assert.equal(typeof report.at, 'number');
  assert.equal(report.trial.startedAt, NOW - 2 * DAY_MS);
  assert.equal(report.trial.elapsedDays, 2);
  assert.equal(report.trial.remainingDays, 28);
  assert.deepEqual(report.wakes, { total: 3, seenPinned: 2, seenEmotion: 2, injectedRate: 1 });
  assert.equal(report.emotionRecited, 2);
  assert.deepEqual(report.proposals, { pending: 2, approved: 1, rejected: 1 });
  assert.deepEqual(report.probe, {
    text: '你在开封',
    found: true,
    memoryId: 'mem_pin_b',
    strength: 0.9995,
    status: 'active',
    layer: 'L3',
  });
  assert.deepEqual(report.drift, { avgReplyLen: 42, serviceToneRate: 0.125, questionTailRate: 0.35 });

  const reportFile = path.join(memoryDir, 'trial-report.json');
  assert.ok(fs.existsSync(reportFile));
  assert.deepEqual(JSON.parse(fs.readFileSync(reportFile, 'utf8')), report);
});

check('--report 无 trial.json 时按默认测试期估算且不写 trial.json', () => {
  const { stateDir, memoryDir } = trialFixtureState({ withTrial: false });
  const report = parseCliJson(runCli(['--state', stateDir, '--report', '--json']));
  assert.equal(report.trial.elapsedDays, 0);
  assert.equal(report.trial.remainingDays, 30);
  assert.equal(report.probe.found, true);
  assert.equal(report.probe.memoryId, 'mem_pin_b');
  assert.equal(fs.existsSync(path.join(memoryDir, 'trial.json')), false);
  assert.ok(fs.existsSync(path.join(memoryDir, 'trial-report.json')));
});

check('--report 在空 state 目录也能生成报告', () => {
  const state = path.join(makeTmp(), 'state');
  const report = parseCliJson(runCli(['--state', state, '--report', '--json']));
  assert.equal(report.ok, true);
  assert.deepEqual(report.wakes, { total: 0, seenPinned: 0, seenEmotion: 0, injectedRate: 0 });
  assert.deepEqual(report.probe, {
    text: '你在开封',
    found: false,
    memoryId: null,
    strength: 0,
    status: null,
    layer: null,
  });
  assert.deepEqual(report.proposals, { pending: 0, approved: 0, rejected: 0 });
  assert.ok(fs.existsSync(path.join(state, 'memory', 'trial-report.json')));
});

check('探针匹配「去代词」：只记得「开封」也算找到', () => {
  const { stateDir } = trialFixtureState({ withTrial: false, withSelfReview: false });
  writeJson(path.join(stateDir, 'memory', 'brain.json'), {
    memories: [
      {
        id: 'mem_kf',
        title: '开封，凌晨',
        text: '开封的夜风',
        status: 'active',
        strength: 0.5,
        layer: 'L2',
      },
    ],
  });
  const report = parseCliJson(runCli(['--state', stateDir, '--report', '--json']));
  assert.equal(report.probe.found, true);
  assert.equal(report.probe.memoryId, 'mem_kf');
  assert.equal(report.probe.strength, 0.5);
  assert.equal(report.probe.status, 'active');
  assert.equal(report.probe.layer, 'L2');
});

check('探针优先命中标题（管理员在开封）而不是正文顺带提到', () => {
  const { stateDir } = trialFixtureState({ withTrial: false, withSelfReview: false });
  writeJson(path.join(stateDir, 'memory', 'brain.json'), {
    memories: {
      mem_title: {
        id: 'mem_title',
        title: '管理员在开封',
        text: '管理员自己说在开封。',
        status: 'active',
        strength: 0.5,
        layer: 'L3',
      },
      mem_text: {
        id: 'mem_text',
        title: 'Bug修复：旧记忆写回问题',
        text: '修复了「管理员在开封」这条记忆写回丢失字段的问题。',
        status: 'active',
        strength: 0.99,
        layer: 'long',
      },
    },
  });
  const report = parseCliJson(runCli(['--state', stateDir, '--report', '--json']));
  assert.equal(report.probe.found, true);
  assert.equal(report.probe.memoryId, 'mem_title');
  assert.equal(report.probe.strength, 0.5);
});

check('探针标题命中整体压过正文引用（台账记忆不抢探针）', () => {
  const { stateDir } = trialFixtureState({ withTrial: false, withSelfReview: false });
  writeJson(path.join(stateDir, 'memory', 'brain.json'), {
    memories: {
      mem_real: {
        id: 'mem_real',
        title: '管理员在开封',
        text: '管理员自己说在开封。',
        status: 'active',
        strength: 0.5,
        layer: 'long',
      },
      mem_ledger: {
        id: 'mem_ledger',
        title: '成长 v1.7 上线：一个月测试台',
        text: '探针「你在开封」；唤醒先看；情绪复读。',
        status: 'active',
        strength: 1,
        layer: 'long',
      },
    },
  });
  const report = parseCliJson(runCli(['--state', stateDir, '--report', '--json']));
  assert.equal(report.probe.found, true);
  assert.equal(report.probe.memoryId, 'mem_real');
});

check('无 self-review 时 drift 用 wake-log 的 replyLen 兜底', () => {
  const { stateDir } = trialFixtureState({ withTrial: false, withSelfReview: false });
  const memoryDir = path.join(stateDir, 'memory');
  writeJson(path.join(memoryDir, 'brain.json'), {});
  writeText(
    path.join(memoryDir, 'wake-log.jsonl'),
    `${JSON.stringify({ at: NOW - 2, sawPinned: true, replyLen: 10 })}\n` +
      `${JSON.stringify({ at: NOW - 1, sawRelated: true, replyLen: 20 })}\n`,
  );
  const report = parseCliJson(runCli(['--state', stateDir, '--report', '--json']));
  assert.deepEqual(report.wakes, { total: 2, seenPinned: 1, seenEmotion: 0, injectedRate: 1 });
  assert.deepEqual(report.drift, { avgReplyLen: 15, serviceToneRate: 0, questionTailRate: 0 });
});

check('--report 人读摘要可用，--quiet 静默', () => {
  const { stateDir } = trialFixtureState();
  const human = runCli(['--state', stateDir, '--report']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /记忆·一个月测试台报告/);
  assert.match(human.stdout, /开封探针：还记得/);
  const quiet = runCli(['--state', stateDir, '--report', '--quiet']);
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout.trim(), '');
});

check('--help 输出用法、未知参数退出码 1', () => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法/);
  const bad = runCli(['--nope']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /未知参数/);
  const badDays = runCli(['--days', 'abc']);
  assert.equal(badDays.status, 1);
  assert.match(badDays.stderr, /--days/);
});

// ---------------------------------------------------------------- 汇总

console.log(`总计：${passed} 项通过，${failures.length} 项失败`);

for (const dir of tmpDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结果
  }
}

if (failures.length > 0) {
  process.exitCode = 1;
}
