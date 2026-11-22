#!/usr/bin/env node
// scripts/memory-trial.mjs
// 记忆·一个月测试台：开一个月的观察期，记录唤醒 / 记忆注入 / 情绪复读 / 开封探针，
// 一个月后判断还记不记得「你在开封」，以及语气有没有慢慢跑偏。
//
// 用法：
//   node scripts/memory-trial.mjs --init [--days 30] [--state state] [--json]
//   node scripts/memory-trial.mjs --report [--json] [--quiet]
//   node scripts/memory-trial.mjs                 # 等价于 --report
//
// 约定：
//   <root>/state/memory/  记忆目录：
//     brain.json          （bridge 维护）
//     wake-log.jsonl      （bridge 每次唤醒追加，每行是 wake-habit.mjs 的 normalizeWakeLog 结果）
//     self-review.json    （self-upgrade 的每周自评结果，可选）
//     trial.json          （--init 写入）
//     trial-report.json   （--report 写入）
//   --state 语义与 scripts/memory-maintenance.mjs 一致：传 state 目录，记忆文件在其 memory/ 下。
//   为了好上手，额外容错：若 --state 指向的目录本身叫 memory，或该目录下直接有 brain.json，
//   则把它当记忆目录本身。
//
// 只用 node 内置模块，无新增依赖。

import fs from 'node:fs';
import path from 'node:path';
import { MemoryStore } from '../src/memory/store.mjs';
import { fileURLToPath } from 'node:url';
import { parseWakeLog } from '../src/memory/wake-habit.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DAYS = 30;
export const PROBE_TEXT = '你在开封';
export const DAY_MS = 24 * 60 * 60 * 1000;

function round(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}
const round1 = (value) => round(value, 1);
const round2 = (value) => round(value, 2);
const round4 = (value) => round(value, 4);

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? Math.round(value) : 0;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return 0;
    if (/^\d{10,}$/.test(text)) {
      const num = Number(text);
      return Number.isFinite(num) ? num : 0;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  return 0;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJsonSafe(file) {
  const text = readTextSafe(file);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 参数解析

function nextValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`缺少参数值：${flag}`);
  }
  return value;
}

export function parseArgs(argv = []) {
  const flags = {
    root: null,
    state: null,
    init: false,
    report: false,
    json: false,
    quiet: false,
    days: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        flags.root = nextValue(argv, ++i, arg);
        break;
      case '--state':
        flags.state = nextValue(argv, ++i, arg);
        break;
      case '--days':
        flags.days = nextValue(argv, ++i, arg);
        break;
      case '--init':
        flags.init = true;
        break;
      case '--report':
        flags.report = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--quiet':
      case '-q':
        flags.quiet = true;
        break;
      case '--help':
      case '-h':
        flags.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return flags;
}

export function resolvePaths(flags = {}) {
  const root = flags.root ? path.resolve(flags.root) : REPO_ROOT;
  const stateDir = flags.state ? path.resolve(flags.state) : path.join(root, 'state');
  let memoryDir;
  if (path.basename(stateDir).toLowerCase() === 'memory') {
    memoryDir = stateDir;
  } else if (
    !fs.existsSync(path.join(stateDir, 'memory')) &&
    fs.existsSync(path.join(stateDir, 'brain.json'))
  ) {
    memoryDir = stateDir;
  } else {
    memoryDir = path.join(stateDir, 'memory');
  }
  return { root, stateDir, memoryDir };
}

export function parseDays(raw) {
  if (raw == null || raw === '') return DEFAULT_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 3660) {
    throw new Error(`--days 需为 1~3660 的整数，收到：${raw}`);
  }
  return days;
}

// ---------------------------------------------------------------- 测试期

function normalizeTrialProbe(probe) {
  const text =
    typeof probe?.text === 'string' && probe.text.trim() ? probe.text.trim() : PROBE_TEXT;
  const baseline = probe?.baselineMemoryId;
  return {
    text,
    baselineMemoryId: baseline == null || baseline === '' ? null : String(baseline),
  };
}

/**
 * 读取 trial.json；不存在/非法时按 --init 语义生成「内存态」测试期（不写盘）。
 * @returns {{ trial: object, implicit: boolean }}
 */
export function resolveTrial({ memoryDir, days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const raw = asObject(readJsonSafe(path.join(path.resolve(memoryDir), 'trial.json')));
  const startedAt = toMs(raw.startedAt ?? raw.createdAt);
  if (startedAt > 0) {
    const storedDays = finiteOrNull(raw.durationDays);
    return {
      trial: {
        startedAt,
        durationDays: storedDays && storedDays > 0 ? Math.round(storedDays) : days,
        probe: normalizeTrialProbe(raw.probe),
      },
      implicit: false,
    };
  }
  return {
    trial: {
      startedAt: now,
      durationDays: days,
      probe: { text: PROBE_TEXT, baselineMemoryId: null },
    },
    implicit: true,
  };
}

/**
 * 开启测试台：写 <memoryDir>/trial.json。
 * 幂等：若已有合法 trial.json，则沿用原测试期（不让一次误点重置一个月的观察），
 * 返回 { trial, reused }。想真正重开测试期，删掉 trial.json 再 --init。
 */
export function initTrial({ memoryDir, days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const dir = path.resolve(memoryDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'trial.json');

  const existing = asObject(readJsonSafe(file));
  const existingStartedAt = toMs(existing.startedAt ?? existing.createdAt);
  if (existingStartedAt > 0) {
    const storedDays = finiteOrNull(existing.durationDays);
    return {
      trial: {
        startedAt: existingStartedAt,
        durationDays: storedDays && storedDays > 0 ? Math.round(storedDays) : days,
        probe: normalizeTrialProbe(existing.probe),
      },
      reused: true,
    };
  }

  const trial = {
    startedAt: now,
    durationDays: days,
    probe: { text: PROBE_TEXT, baselineMemoryId: null },
    createdAt: now,
  };
  fs.writeFileSync(file, `${JSON.stringify(trial, null, 2)}\n`, 'utf8');
  return { trial, reused: false };
}

// ---------------------------------------------------------------- 报告计算

function memoryList(brain) {
  const raw = brain && typeof brain === 'object' ? brain.memories : null;
  if (Array.isArray(raw)) return raw.filter((item) => item && typeof item === 'object');
  if (raw && typeof raw === 'object') {
    return Object.values(raw).filter((item) => item && typeof item === 'object');
  }
  return [];
}

function stripPronouns(text) {
  return String(text ?? '')
    .trim()
    .replace(/^(?:你们|我们|他们|她们|它们|你|我|他|她|它)/, '')
    .trim();
}

function stripLeadingVerb(text) {
  return String(text ?? '')
    .trim()
    .replace(/^(?:在|去|到|回|来|于)/, '')
    .trim();
}

/**
 * 探针关键词变体：先用完整 probe.text，再去代词取核心（你在开封 → 在开封），
 * 最后去掉「在/去/到…」得到最小词（→ 开封）。命中越精确分越高。
 */
function probeVariants(text) {
  const complete = String(text ?? '').trim();
  const core = stripPronouns(complete);
  const bare = stripLeadingVerb(core);
  const seen = new Set();
  const variants = [];
  for (const [value, score] of [
    [complete, 3],
    [core, 2],
    [bare, 1],
  ]) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    variants.push({ value, score });
  }
  return variants;
}

/** 在 brain.memories 里找「开封」探针记忆；找不到返回 found:false 的完整结构。 */
export function findProbeMemory(brain, probe = {}) {
  const text =
    typeof probe?.text === 'string' && probe.text.trim() ? probe.text.trim() : PROBE_TEXT;
  const baselineId = probe?.baselineMemoryId == null ? '' : String(probe.baselineMemoryId);
  const variants = probeVariants(text);

  let best = null;
  for (const memory of memoryList(brain)) {
    const title = String(memory.title ?? '');
    const body = [
      String(memory.text ?? ''),
      Array.isArray(memory.keywords) ? memory.keywords.join(' ') : '',
      Array.isArray(memory.tags) ? memory.tags.join(' ') : '',
    ].join('\n');
    let titleScore = 0;
    let bodyScore = 0;
    for (const variant of variants) {
      // 标题命中整体压过正文命中：「管理员在开封」这条记忆 vs 别的记忆里引用「你在开封」。
      if (title.includes(variant.value)) titleScore = Math.max(titleScore, variant.score + 1);
      else if (body.includes(variant.value)) bodyScore = Math.max(bodyScore, variant.score);
    }
    let score = titleScore > 0 ? 10 + titleScore : bodyScore;
    if (score === 0) continue;
    const id = String(memory.id ?? '');
    if (baselineId && id === baselineId) score += 1;
    const strength = round4(Number(memory.strength));
    const updated = toMs(memory.updatedAt) || toMs(memory.lastActivatedAt) || toMs(memory.createdAt);
    const candidate = { score, strength: Number.isFinite(strength) ? strength : 0, updated, memory };
    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score &&
        (candidate.strength > best.strength ||
          (candidate.strength === best.strength && candidate.updated > best.updated)))
    ) {
      best = candidate;
    }
  }

  if (!best) {
    return { text, found: false, memoryId: null, strength: 0, status: null, layer: null };
  }
  const memory = best.memory;
  return {
    text,
    found: true,
    memoryId: memory.id ?? null,
    strength: best.strength,
    status: memory.status ?? null,
    layer: memory.layer ?? null,
  };
}

function findDrift(selfReview) {
  const candidates = [
    selfReview.drift,
    selfReview.report?.drift,
    selfReview.weeklyReview?.drift,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  return null;
}

/**
 * 跑偏指标：优先用 self-review.json 的 drift（weeklyReview 的统计），
 * 缺失时用唤醒日志里的 replyLen 均值兜底，比率类没有数据就记 0。
 */
export function buildDrift(wakeEntries, selfReview) {
  const drift = findDrift(asObject(selfReview));
  const lengths = wakeEntries
    .map((entry) => entry.replyLen)
    .filter((len) => Number.isFinite(len) && len > 0);
  const avgFromLog = lengths.length
    ? round1(lengths.reduce((sum, len) => sum + len, 0) / lengths.length)
    : 0;

  const avgRaw = drift
    ? finiteOrNull(drift.avgLen ?? drift.avgReplyLen ?? drift.avgLength)
    : null;
  const avgReplyLen = avgRaw == null ? avgFromLog : round1(avgRaw);
  const serviceToneRate = drift ? round4(finiteOrNull(drift.serviceToneRate) ?? 0) : 0;
  const questionTailRate = drift ? round4(finiteOrNull(drift.questionTailRate) ?? 0) : 0;

  return { avgReplyLen, serviceToneRate, questionTailRate };
}

function pickProposals(brain, selfReview) {
  const sources = [
    brain.self?.proposals,
    brain.proposals,
    selfReview.proposals,
    selfReview.report?.proposals,
    selfReview.weeklyReview?.proposals,
  ];
  for (const list of sources) {
    if (Array.isArray(list) && list.length > 0) return list;
  }
  for (const list of sources) {
    if (Array.isArray(list)) return list;
  }
  return [];
}

export function countProposals(list) {
  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const proposal of Array.isArray(list) ? list : []) {
    const status = String(proposal?.status ?? proposal?.decision ?? 'pending').toLowerCase();
    if (status === 'approved') counts.approved += 1;
    else if (status === 'rejected') counts.rejected += 1;
    else counts.pending += 1;
  }
  return counts;
}

/**
 * 生成测试台报告（不写盘）。返回结构严格按契约：
 * { ok, at, trial:{startedAt,elapsedDays,remainingDays},
 *   wakes:{total,seenPinned,seenEmotion,injectedRate},
 *   emotionRecited, proposals:{pending,approved,rejected},
 *   probe:{text,found,memoryId,strength,status,layer},
 *   drift:{avgReplyLen,serviceToneRate,questionTailRate} }
 * 另有一个不可枚举的 implicit 标记（表示 trial.json 不存在、按默认测试期估算）。
 */
/**
 * 读 brain：优先用 MemoryStore（会回放 journal 增量），失败再退回直接解析 brain.json。
 * 只读，不创建文件。
 */
function loadBrainSafe(memoryDir) {
  // 只有存在 journal（增量写盘）时才走 MemoryStore 回放；否则直接读 brain.json，
  // 保持对手写/测试 fixture 的忠实读取（不做 schema 归一化）。
  if (fs.existsSync(path.join(memoryDir, 'journal.jsonl'))) {
    try {
      const stateDir = path.basename(memoryDir).toLowerCase() === 'memory' ? path.dirname(memoryDir) : memoryDir;
      const repoRoot = path.dirname(stateDir);
      const store = new MemoryStore({ repoRoot, stateDir });
      const brain = store.load();
      if (brain && typeof brain === 'object') return brain;
    } catch {
      /* 回退 */
    }
  }
  return asObject(readJsonSafe(path.join(memoryDir, 'brain.json')));
}

export function buildReport({ memoryDir, days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const dir = path.resolve(memoryDir);
  const entries = parseWakeLog(readTextSafe(path.join(dir, 'wake-log.jsonl')) ?? '');
  const brain = loadBrainSafe(dir);
  const selfReview = asObject(readJsonSafe(path.join(dir, 'self-review.json')));

  const { trial, implicit } = resolveTrial({ memoryDir: dir, days, now });
  const startedAt = toMs(trial.startedAt) || now;
  const durationDays =
    Number(trial.durationDays) > 0 ? Math.round(Number(trial.durationDays)) : days;
  const elapsedDays = round2(Math.max(0, (now - startedAt) / DAY_MS));
  const remainingDays = round2(Math.max(0, durationDays - elapsedDays));

  const total = entries.length;
  const seenPinned = entries.filter((entry) => entry.sawPinned).length;
  const seenEmotion = entries.filter((entry) => entry.sawEmotion).length;
  const injected = entries.filter((entry) => entry.sawPinned || entry.sawRelated).length;
  const injectedRate = total > 0 ? round4(injected / total) : 0;

  const report = {
    ok: true,
    at: now,
    trial: { startedAt, elapsedDays, remainingDays },
    wakes: { total, seenPinned, seenEmotion, injectedRate },
    emotionRecited: seenEmotion,
    proposals: countProposals(pickProposals(brain, selfReview)),
    probe: findProbeMemory(brain, trial.probe),
    drift: buildDrift(entries, selfReview),
  };
  Object.defineProperty(report, 'implicit', { value: implicit, enumerable: false });
  return report;
}

/** 写 <memoryDir>/trial-report.json，返回文件路径。 */
export function writeReport(memoryDir, report) {
  const dir = path.resolve(memoryDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'trial-report.json');
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return file;
}

// ---------------------------------------------------------------- 输出

function printUsage() {
  console.log(`记忆·一个月测试台

用法：
  node scripts/memory-trial.mjs --init [--days 30] [--state <state>] [--root <repo>] [--json]
  node scripts/memory-trial.mjs --report [--json] [--quiet]
  node scripts/memory-trial.mjs            # 不带 --init 时默认执行 --report

参数：
  --init      写 <state>/memory/trial.json（已存在则沿用原测试期）
  --report    读 wake-log.jsonl / brain.json / self-review.json / trial.json，
              输出报告并写 trial-report.json；无 trial.json 时按默认测试期估算（不写盘）
  --days N    测试期天数，默认 30
  --state DIR state 目录，默认 <root>/state
  --root DIR  仓库根目录，默认本脚本上一级
  --json      只输出 JSON
  --quiet     不输出人读摘要（仍写报告文件）
  --help      显示本帮助`);
}

function printHumanReport(report, { memoryDir, implicit }) {
  const started = new Date(report.trial.startedAt);
  const startedText = Number.isNaN(started.getTime())
    ? String(report.trial.startedAt)
    : started.toISOString();
  const remembered = report.probe.found ? '还记得' : '没找到';
  console.log('记忆·一个月测试台报告');
  console.log(
    `  测试期：${startedText} 起，已过 ${report.trial.elapsedDays} 天，剩余 ${report.trial.remainingDays} 天${implicit ? '（未初始化 trial.json，按默认天数估算）' : ''}`,
  );
  console.log(
    `  唤醒：${report.wakes.total} 次；记忆注入率 ${(report.wakes.injectedRate * 100).toFixed(1)}%（置顶 ${report.wakes.seenPinned} 次 / 情绪 ${report.wakes.seenEmotion} 次）`,
  );
  console.log(`  情绪复读：${report.emotionRecited} 次`);
  console.log(
    `  开封探针：${remembered}${report.probe.memoryId ? `（${report.probe.memoryId}）` : ''}；强度 ${report.probe.strength}，状态 ${report.probe.status ?? '无'}，层级 ${report.probe.layer ?? '无'}`,
  );
  console.log(
    `  跑偏：平均回复 ${report.drift.avgReplyLen} 字；客服腔 ${(report.drift.serviceToneRate * 100).toFixed(1)}%；反问收尾 ${(report.drift.questionTailRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  自我提案：待审 ${report.proposals.pending} / 已批准 ${report.proposals.approved} / 已驳回 ${report.proposals.rejected}`,
  );
  console.log(`  报告已写入：${path.join(memoryDir, 'trial-report.json')}`);
}

// ---------------------------------------------------------------- 入口

export function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (flags.help) {
    printUsage();
    return 0;
  }

  const paths = resolvePaths(flags);
  const days = parseDays(flags.days);
  const now = Date.now();

  const doInit = flags.init;
  const doReport = flags.report || !flags.init;

  let initResult = null;
  if (doInit) {
    initResult = initTrial({ memoryDir: paths.memoryDir, days, now });
    if (!flags.json && !flags.quiet) {
      const trial = initResult.trial;
      const startedText = new Date(trial.startedAt).toISOString();
      console.log(
        initResult.reused
          ? `测试台已存在，沿用原测试期（开始于 ${startedText}，共 ${trial.durationDays} 天）`
          : `测试台已开启：开始于 ${startedText}，共 ${trial.durationDays} 天；探针文本「${trial.probe.text}」`,
      );
      console.log(`  trial.json → ${path.join(paths.memoryDir, 'trial.json')}`);
    }
  }

  if (doReport) {
    const report = buildReport({ memoryDir: paths.memoryDir, days, now });
    writeReport(paths.memoryDir, report);
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (!flags.quiet) {
      printHumanReport(report, { memoryDir: paths.memoryDir, implicit: report.implicit === true });
    }
  } else if (flags.json && initResult) {
    console.log(JSON.stringify({ ok: true, trial: initResult.trial, reused: initResult.reused }, null, 2));
  }

  return 0;
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  try {
    const code = main(process.argv.slice(2));
    if (code) process.exitCode = code;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`[memory-trial] ${message}`);
    }
    process.exitCode = 1;
  }
}
