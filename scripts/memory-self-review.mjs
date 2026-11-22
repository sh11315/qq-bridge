#!/usr/bin/env node
/**
 * 每周自我审视（只读 brain.json，不修改记忆库）。
 *
 * 做四件事：
 *   1) 读 state/memory/brain.json，把最近的 memories（title + text，时间取 updatedAt||createdAt）
 *      还原成"我说过的话"条目；
 *   2) 用 src/memory/self-upgrade.mjs 的外部卡尺扫描客服腔 / 问句收尾 / 主动开口过多；
 *   3) 生成"送主人审批"的候选提案（同 rubricId 已有 pending/approved 提案的会跳过）；
 *   4) 输出 JSON（或人读摘要），并把完整结果写到 state/memory/self-review.json。
 *
 * 用法：
 *   node scripts/memory-self-review.mjs                  # 人读摘要，并写 self-review.json
 *   node scripts/memory-self-review.mjs --json           # 只输出一行 JSON（机器消费）
 *   node scripts/memory-self-review.mjs --json --dry-run # 只输出，不写文件
 *   node scripts/memory-self-review.mjs --root <repo> --state <dir> --days 7
 *
 * 参数：
 *   --root <dir>     仓库根（默认当前工作目录）
 *   --state <dir>    state 目录（默认 <root>/state）；brain = <state>/memory/brain.json
 *   --days <n>       回看天数（默认 7）
 *   --json           只输出 JSON（一行），方便计划任务/控制台消费
 *   --dry-run        不写 state/memory/self-review.json
 *   --help, -h       显示本帮助
 *
 * 退出码：0 = 成功（brain.json 不存在时按空记忆处理并给出警告）；1 = 参数/读取/写入失败。
 *
 * 注意：本脚本绝不写 brain.json；提案的持久化与主人审批由 service / 控制台负责。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { weeklyReview } from '../src/memory/self-upgrade.mjs';

const USAGE = `每周自我审视（自升级提案 / 外部卡尺）

用法：
  node scripts/memory-self-review.mjs [选项]

选项：
  --root <dir>     仓库根（默认当前工作目录）
  --state <dir>    state 目录（默认 <root>/state）
  --days <n>       回看天数（默认 7）
  --json           只输出一行 JSON
  --dry-run        不写 self-review.json（只读、只输出）
  --help, -h       显示本帮助
`;

const DEFAULT_DAYS = 7;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--json':
        flags.json = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--root':
        flags.root = argv[++i];
        break;
      case '--state':
        flags.state = argv[++i];
        break;
      case '--days':
        flags.days = argv[++i];
        break;
      case '--help':
      case '-h':
        flags.help = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`未知选项：${arg}`);
        throw new Error(`多余参数：${arg}`);
    }
  }
  for (const key of ['root', 'state', 'days']) {
    const value = flags[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
      throw new Error(`选项 --${key} 缺少参数`);
    }
  }
  return flags;
}

function parseDays(value) {
  if (value === undefined) return DEFAULT_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--days 必须是正数，收到：${value}`);
  return Math.floor(days);
}

/** 读取 brain.json；不存在时返回 null（按空记忆处理）。损坏则抛错，不吞掉。 */
function readBrain(brainPath) {
  let text;
  try {
    text = fs.readFileSync(brainPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { brain: null, warning: `brain.json 不存在：${brainPath}` };
    throw new Error(`读取 brain.json 失败：${error?.message ?? error}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`解析 brain.json 失败：${error?.message ?? error}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('brain.json 顶层不是对象');
  }
  return { brain: parsed, warning: null };
}

/** 记忆正文：title + text（都是字符串才参与），压缩空白。 */
function memoryText(memory) {
  const parts = [];
  for (const field of [memory.title, memory.text]) {
    if (typeof field !== 'string') continue;
    const text = field.replace(/\s+/g, ' ').trim();
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

/** 主动开口标记：tags 含 proactive，或 source.kind / source 字符串是 proactive。 */
function memoryKind(memory) {
  const tags = Array.isArray(memory.tags) ? memory.tags.map((tag) => String(tag).toLowerCase()) : [];
  if (tags.includes('proactive')) return 'proactive';
  const source = memory.source;
  const sourceKind =
    source && typeof source === 'object' && !Array.isArray(source) ? String(source.kind ?? '') : String(source ?? '');
  return sourceKind.toLowerCase() === 'proactive' ? 'proactive' : '';
}

/** brain.memories（id→对象映射，也兼容数组）→ 扫描条目 [{text,at,kind}]。 */
function collectMemoryItems(brain) {
  const memories = brain && brain.memories;
  if (!memories || typeof memories !== 'object') return [];
  const values = Array.isArray(memories) ? memories : Object.values(memories);
  const items = [];
  for (const memory of values) {
    if (!memory || typeof memory !== 'object' || Array.isArray(memory)) continue;
    const text = memoryText(memory);
    const at = Number(memory.updatedAt) || Number(memory.createdAt) || 0;
    if (!text || !at) continue;
    items.push({ text, at, kind: memoryKind(memory) });
  }
  items.sort((a, b) => a.at - b.at);
  return items;
}

/** 读已有提案：优先 brain.self.proposals（与 model.normalizeSelf 对齐），兼容旧位置。 */
function collectExistingProposals(brain) {
  if (!brain || typeof brain !== 'object') return [];
  const candidates = [
    brain.self && brain.self.proposals,
    brain.selfUpgrade && brain.selfUpgrade.proposals,
    brain.proposals,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

/** 相对仓库根的路径展示（Windows 反斜杠转正斜杠，方便阅读/跨平台）。 */
function displayPath(root, target) {
  const relative = path.relative(root, target);
  return (relative || path.basename(target)).split(path.sep).join('/');
}

function percent(rate) {
  return `${Math.round((Number(rate) || 0) * 100)}%`;
}

/** 人读摘要：给人看的周报，重点是"想改什么、为什么、等主人判定"。 */
function formatHuman(result) {
  const lines = [];
  lines.push(`◆ 每周自我审视（最近 ${result.windowDays} 天）`);
  if (result.warnings?.length) {
    for (const warning of result.warnings) lines.push(`! ${warning}`);
  }
  lines.push(
    `扫描 ${result.scanned} 条记忆：发现 ${result.issues.length} 个语气问题，生成 ${result.proposals.length} 条待审批提案。`
  );

  if (result.issues.length) {
    lines.push('外部卡尺标出的问题：');
    for (const issue of result.issues) {
      const example = issue.examples?.[0] ? `（例：${issue.examples[0].slice(0, 40)}）` : '';
      lines.push(`- [${issue.label}] 命中 ${issue.count} 条${example}`);
    }
  } else {
    lines.push('这一周没扫出明显的客服腔 / 问句收尾 / 主动开口问题。');
  }

  if (result.proposals.length) {
    lines.push('候选提案（只是提案，主人批准后才生效）：');
    result.proposals.forEach((proposal, index) => {
      lines.push(`${index + 1}. ${proposal.title}`);
      lines.push(`   ${proposal.detail}`);
      lines.push(
        `   自评嫌疑 ${proposal.selfScore}（只是自评，不算数）；外部卡尺：待主人判定 0/1（externalScore=null）`
      );
    });
  } else {
    lines.push('没有新提案（已有待审批/已批准的同类提案时会跳过，避免重复打扰）。');
  }

  const { drift } = result;
  lines.push(
    `语气漂移：平均长度 ${drift.avgLen} 字，问句收尾率 ${percent(drift.questionTailRate)}，客服腔率 ${percent(
      drift.serviceToneRate
    )}。`
  );
  lines.push(`整体自评嫌疑 ${result.selfScore}（0..1，仅作参考）；外部卡尺：待主人判定，externalScore=null。`);
  lines.push(result.outPath ? `完整结果已写入 ${result.outPath}` : '（--dry-run：未写入 self-review.json）');
  return lines.join('\n');
}

function main(argv) {
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const root = path.resolve(flags.root ?? process.cwd());
  const stateDir = path.resolve(root, flags.state ?? 'state');
  const brainPath = path.join(stateDir, 'memory', 'brain.json');
  const outPath = path.join(stateDir, 'memory', 'self-review.json');
  const days = parseDays(flags.days);

  const { brain, warning } = readBrain(brainPath);
  if (warning && !flags.json) process.stderr.write(`[self-review] ${warning}\n`);

  const items = collectMemoryItems(brain);
  const existing = collectExistingProposals(brain);
  const now = Date.now();
  const review = weeklyReview({ items, existing, now, days });

  // 给控制台/服务层直接用的中文摘要（自评口径，明确不算数）。
  const summary = review.scan.issues.length
    ? `最近 ${review.scan.windowDays} 天扫描 ${review.scan.scanned} 条记忆，发现${review.scan.issues
        .map((issue) => `${issue.label} ${issue.count} 条`)
        .join('、')}，生成 ${review.proposals.length} 条待审批提案。`
    : `最近 ${review.scan.windowDays} 天扫描 ${review.scan.scanned} 条记忆，没有扫出明显的客服腔/问句收尾/主动开口问题。`;
  const suspicion = `${Math.round(review.selfScore * 100)}%（只是自评，不算数）`;

  const result = {
    version: 1,
    kind: 'self-review',
    generatedAt: now,
    dryRun: Boolean(flags.dryRun),
    outPath: flags.dryRun ? null : displayPath(root, outPath),
    windowDays: review.scan.windowDays,
    scanned: review.scan.scanned,
    issues: review.scan.issues,
    proposals: review.proposals,
    drift: review.drift,
    selfScore: review.selfScore,
    externalScore: review.externalScore,
    summary,
    suspicion,
    source: {
      root,
      stateDir: displayPath(root, stateDir),
      brainPath: displayPath(root, brainPath),
      memories: items.length,
      existingProposals: existing.length,
    },
    note: '自评只是嫌疑、不是分数；是否生效由主人用外部卡尺判定（externalScore 恒为 null）。',
  };
  if (warning) result.warnings = [warning];

  if (!flags.dryRun) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`${formatHuman(result)}\n`);
  }
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`[self-review] ${error?.message ?? error}\n`);
  process.exitCode = 1;
}
