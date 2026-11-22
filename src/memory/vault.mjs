/**
 * 记忆系统 → Obsidian vault 渲染器。
 *
 * 实现契约：docs/guides/MEMORY_SYSTEM.md §8（目录 / frontmatter / Canvas / SVG / Obsidian 配置）。
 * 纯 node 内置模块（fs/path），不 import memory-core 的代码，只读取 §3 定义的 brain 数据结构。
 *
 * 入口：
 *   export const VAULT_VERSION = 1;
 *   export function renderVault(brain, { vaultDir, now }) -> { files, stats }
 *
 * 生成文件头统一带「自动生成，手改会被覆盖」提示：
 *   - Markdown：写在 frontmatter 内的 YAML 注释里（Obsidian 属性面板仍可正常解析）；
 *   - SVG：XML 注释；Canvas / .obsidian/*.json 是 JSON，不能带注释，改由中心节点与 README 说明。
 *
 * 清理规则：只删除 vaultDir 下 `记忆/`、`实体/`、`日记/` 内的旧 .md，绝不删除其他文件/目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildTopologyFiles, topologySummary } from './topology.mjs';
import { relationLabelOf } from './model.mjs';

/** vault 结构版本，写入 README / SVG / 统计里，便于将来迁移。 */
export const VAULT_VERSION = 1;

/** 所有生成文件头的统一提示（契约 §8 原文措辞）。 */
export const AUTO_GEN_NOTICE =
  '由 QQ Bridge 记忆系统自动生成，手改会被下一次刷新覆盖；要改记忆请让 bot 用 memory_update 或编辑 brain.json 前先备份';

const HTML_BANNER = `<!-- ${AUTO_GEN_NOTICE} -->`;
const YAML_BANNER = `# ${AUTO_GEN_NOTICE}`;
const DAY_MS = 86_400_000;

const DEFAULT_PROTECTION_LINE = 0.5;
const DEFAULT_DECAY_DAYS_LONG = 200;
const DEFAULT_DECAY_DAYS_SHORT = 30;
const DEFAULT_FADE_THRESHOLD = 0.15;
const DEFAULT_FORGET_THRESHOLD = 0.05;

/** vault 分层：目录名 / 展示名 / Canvas 颜色（契约指定 6=金 5=蓝 3=灰）/ SVG 颜色 / Graph View 颜色。 */
export const LAYER_META = Object.freeze({
  permanent: {
    dir: '永久',
    label: '永久记忆',
    shortLabel: '永久',
    description: 'protection = 1，永不衰减',
    svgColor: '#F5B301',
    canvasColor: '6',
    graphRgb: 0xf5b301,
    order: 0,
  },
  long: {
    dir: '长期',
    label: '长期记忆',
    shortLabel: '长期',
    description: '默认 200 天线性衰减',
    svgColor: '#3B82F6',
    canvasColor: '5',
    graphRgb: 0x3b82f6,
    order: 1,
  },
  short: {
    dir: '短期',
    label: '短期记忆',
    shortLabel: '短期',
    description: '默认 30 天线性衰减',
    svgColor: '#9CA3AF',
    canvasColor: '3',
    graphRgb: 0x9ca3af,
    order: 2,
  },
  edge: {
    dir: '边缘',
    label: '边缘记忆',
    shortLabel: '边缘',
    description: 'fading / faded，即将淡忘',
    svgColor: '#4B5563',
    canvasColor: null,
    graphRgb: 0x4b5563,
    order: 3,
  },
  superseded: {
    dir: '已取代',
    label: '已取代记忆',
    shortLabel: '已取代',
    description: '被新决策覆盖，默认不召回（v1.3）',
    svgColor: '#8B5CF6',
    canvasColor: '4',
    graphRgb: 0x8b5cf6,
    order: 4,
  },
});

export const LAYER_ORDER = Object.freeze(['permanent', 'long', 'short', 'edge', 'superseded']);

export const ENTITY_TYPE_META = Object.freeze({
  person: { label: '人物', color: '#7C3AED', order: 0 },
  group: { label: '群聊', color: '#0EA5E9', order: 1 },
  topic: { label: '话题', color: '#F59E0B', order: 2 },
  term: { label: '术语', color: '#10B981', order: 3 },
  event: { label: '事件', color: '#EF4444', order: 4 },
  project: { label: '项目', color: '#6366F1', order: 5 },
  self: { label: '自我', color: '#EC4899', order: 6 },
  other: { label: '其他', color: '#64748B', order: 7 },
});

export const ENTITY_TYPE_ORDER = Object.freeze([
  'person',
  'group',
  'topic',
  'term',
  'event',
  'project',
  'self',
  'other',
]);

// 主页导航每个分组最多列出的条数（vault 文件仍是全量）。
const HOME_LIST_LIMIT = 40;
// 实体笔记里每个实体最多列出的关联记忆数（与 §4 maxMemoriesPerEntityLink 对齐）。
const ENTITY_MEMORY_LIMIT = 50;
// Canvas / SVG 是「示意图」，节点过多时按强度取前 N 个（README 有说明）。
const CANVAS_CAPS = { permanent: 60, long: 110, short: 90, edge: 50, superseded: 40, entities: 120 };
const SVG_CAPS = { permanent: 28, long: 96, short: 64, edge: 48, superseded: 32, entities: 56 };
const CANVAS_MAX_MEMORY_ENTITY_EDGES = 400;
const SVG_MAX_MEMORY_ENTITY_LINKS = 260;

// Obsidian Graph View 的颜色组（契约 §8：永久金 / 长期蓝 / 短期灰 / 实体绿 / 边缘暗 / 日记青 / 已取代紫）。
const GRAPH_COLOR_GROUPS = [
  { query: 'path:"记忆/永久"', rgb: LAYER_META.permanent.graphRgb, label: '永久记忆（金）' },
  { query: 'path:"记忆/长期"', rgb: LAYER_META.long.graphRgb, label: '长期记忆（蓝）' },
  { query: 'path:"记忆/短期"', rgb: LAYER_META.short.graphRgb, label: '短期记忆（灰）' },
  { query: 'path:"日记"', rgb: 0x14b8a6, label: '日记（青）' },
  { query: 'path:"实体"', rgb: 0x22c55e, label: '实体（绿）' },
  { query: 'path:"记忆/边缘"', rgb: LAYER_META.edge.graphRgb, label: '边缘记忆（暗）' },
  { query: 'path:"记忆/已取代"', rgb: LAYER_META.superseded.graphRgb, label: '已取代记忆（紫）' },
];

const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/** 字符数（按码点，不切坏 emoji / 中文）。 */
function truncateChars(value, maxChars) {
  const chars = Array.from(String(value ?? ''));
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : chars.join('');
}

function firstChar(value) {
  const chars = Array.from(String(value ?? '').trim());
  return chars.length > 0 ? chars[0] : '·';
}

/** 展示用截断：去掉尾部空白，超长时以省略号结尾（占 1 个字符位）。 */
function truncateLabel(value, maxChars) {
  const chars = Array.from(String(value ?? '').trim());
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('').trimEnd()}…`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 时间戳 → ISO（0 / null / 非法值 → null，避免出现 1970 年假数据）。 */
function toIso(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** 确定性展示时间（固定 UTC，保证同一 now 生成同样字节）。 */
function formatUtc(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '未知';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '未知';
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(
    d.getUTCHours(),
  )}:${pad2(d.getUTCMinutes())} UTC`;
}

function percent(value) {
  return `${Math.round(clamp(value, 0, 1) * 100)}%`;
}

/** 十格进度条：满 10 格 = 强度 100%。 */
export function progressBar(strength) {
  const filled = Math.round(clamp(Number(strength), 0, 1) * 10);
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trim();
}

/** Windows / Obsidian 都能接受的文件名清洗（中文保留）。 */
function sanitizeFilename(input, maxChars = 60) {
  let name = String(input ?? '')
    .normalize('NFC')
    .replace(ILLEGAL_FILENAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (WINDOWS_RESERVED_NAMES.test(name)) name = `_${name}`;
  if (Array.from(name).length > maxChars) {
    name = truncateChars(name, maxChars).replace(/[. ]+$/g, '').trim();
  }
  return name || 'unnamed';
}

/** 标题 → 文件名 slug（保留中文，空格折叠成 -）。 */
function slugify(input, maxChars = 40) {
  let slug = String(input ?? '')
    .normalize('NFC')
    .replace(ILLEGAL_FILENAME_CHARS, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (Array.from(slug).length > maxChars) {
    slug = truncateChars(slug, maxChars).replace(/[-.]+$/g, '');
  }
  return slug || 'untitled';
}

/** Obsidian wikilink 的显示文本里不能出现的字符（否则链接解析会错）。 */
function wikiLabel(text, maxChars = 60) {
  const clean = normalizeNewlines(text)
    .replace(/\|/g, '｜')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］');
  return truncateChars(clean, maxChars);
}

/** XML 文本/属性转义。 */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function num(value) {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '0';
}

/** 把 SVG 文本标签的 x 夹在画布内，避免靠近边缘时被裁掉。 */
function clampSvgLabelX(x, anchor, width) {
  const margin = 26;
  if (anchor === 'start') return Math.min(x, width - margin);
  if (anchor === 'end') return Math.max(x, margin);
  return Math.min(Math.max(x, margin), width - margin);
}

// ---------------------------------------------------------------------------
// YAML frontmatter（不用第三方库；只覆盖本模块需要的标量 / 数组 / 单层对象）
// ---------------------------------------------------------------------------

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(String(value));
}

function yamlArray(values) {
  if (!Array.isArray(values) || values.length === 0) return '[]';
  return `[${values.map((v) => yamlScalar(v)).join(', ')}]`;
}

function yamlKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
}

/** 生成 Obsidian 可解析的 frontmatter；第一行是「自动生成」提示注释。 */
function toFrontmatter(fields) {
  const lines = ['---', YAML_BANNER];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${yamlKey(key)}:`);
      for (const [childKey, childValue] of Object.entries(value)) {
        if (childValue === undefined) continue;
        lines.push(
          `  ${yamlKey(childKey)}: ${Array.isArray(childValue) ? yamlArray(childValue) : yamlScalar(childValue)}`,
        );
      }
    } else if (Array.isArray(value)) {
      lines.push(`${yamlKey(key)}: ${yamlArray(value)}`);
    } else {
      lines.push(`${yamlKey(key)}: ${yamlScalar(value)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function stringList(value, { maxItems = 30, maxChars = 60 } = {}) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = String(item ?? '').trim();
    if (!text) continue;
    out.push(truncateChars(text, maxChars));
    if (out.length >= maxItems) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// brain → 渲染模型
// ---------------------------------------------------------------------------

function normalizeConfig(rawConfig) {
  const cfg = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {};
  return {
    protectionLine: clampNumber(cfg.protectionLine, 0, 1, DEFAULT_PROTECTION_LINE),
    decayDaysLong: positiveNumber(cfg.decayDaysLong, DEFAULT_DECAY_DAYS_LONG),
    decayDaysShort: positiveNumber(cfg.decayDaysShort, DEFAULT_DECAY_DAYS_SHORT),
    fadeThreshold: clampNumber(cfg.fadeThreshold, 0, 1, DEFAULT_FADE_THRESHOLD),
    forgetThreshold: clampNumber(cfg.forgetThreshold, 0, 1, DEFAULT_FORGET_THRESHOLD),
    purgeGraceDays: positiveNumber(cfg.purgeGraceDays, 7),
  };
}

function normalizeEntities(rawEntities) {
  const entries = Array.isArray(rawEntities)
    ? rawEntities.map((value, index) => [String(value?.id ?? `ent_${index}`), value])
    : rawEntities && typeof rawEntities === 'object'
      ? Object.entries(rawEntities)
      : [];
  const out = [];
  const seen = new Set();
  for (const [key, value] of entries) {
    if (!value || typeof value !== 'object') continue;
    const id = String(value.id ?? key ?? '').trim();
    const name = String(value.name ?? '').trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const type = Object.hasOwn(ENTITY_TYPE_META, value.type) ? String(value.type) : 'other';
    out.push({
      id,
      type,
      name,
      aliases: stringList(value.aliases, { maxItems: 20 }),
      tags: stringList(value.tags, { maxItems: 20 }),
      note: normalizeNewlines(value.note),
      mentionCount: Number.isFinite(Number(value.mentionCount)) ? Math.max(0, Number(value.mentionCount)) : 0,
      firstSeenAt: Number.isFinite(Number(value.firstSeenAt)) ? Number(value.firstSeenAt) : 0,
      lastMentionedAt: Number.isFinite(Number(value.lastMentionedAt)) ? Number(value.lastMentionedAt) : 0,
      createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : 0,
      updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0,
      source: normalizeSource(value.source),
    });
  }
  return out;
}

function normalizeSource(rawSource) {
  if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) return null;
  const source = {};
  if (typeof rawSource.kind === 'string' && rawSource.kind.trim()) source.kind = rawSource.kind.trim();
  if (typeof rawSource.key === 'string' && rawSource.key.trim()) source.key = rawSource.key.trim();
  if (Array.isArray(rawSource.seqs)) {
    const seqs = rawSource.seqs
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n))
      .slice(0, 30);
    if (seqs.length > 0) source.seqs = seqs;
  }
  if (typeof rawSource.createdBy === 'string' && rawSource.createdBy.trim()) {
    source.createdBy = rawSource.createdBy.trim();
  }
  return Object.keys(source).length > 0 ? source : null;
}

function normalizeRelations(rawRelations, entitiesById) {
  if (!Array.isArray(rawRelations)) return [];
  const out = [];
  const seen = new Set();
  for (let index = 0; index < rawRelations.length; index += 1) {
    const value = rawRelations[index];
    if (!value || typeof value !== 'object') continue;
    const from = String(value.from ?? '').trim();
    const to = String(value.to ?? '').trim();
    if (!from || !to || from === to) continue;
    const fromEntity = entitiesById.get(from);
    const toEntity = entitiesById.get(to);
    if (!fromEntity || !toEntity) continue;
    const relation = String(value.relation ?? 'related').trim() || 'related';
    const id = String(value.id ?? `rel_${index}_${from}_${to}`).trim();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      from,
      to,
      relation,
      weight: positiveNumber(value.weight, 1),
      note: normalizeNewlines(value.note),
      fromEntity,
      toEntity,
    });
  }
  return out;
}

function isDiaryMemory(memory) {
  const tags = memory?.tags;
  return Array.isArray(tags) && tags.some((tag) => String(tag ?? '').trim().toLowerCase() === 'diary');
}

function computeStrength(memory, now) {
  if (memory.permanent || isDiaryMemory(memory)) return 1;
  const decayDays = Number(memory.decayDays);
  const baseStrength = Number(memory.baseStrength);
  const lastActivatedAt = Number(memory.lastActivatedAt);
  // 有完整衰减字段时按 §3 公式重算（brain 里落盘的 strength 是物化值，读取时以公式为准）。
  if (
    Number.isFinite(decayDays) &&
    decayDays > 0 &&
    Number.isFinite(baseStrength) &&
    Number.isFinite(lastActivatedAt) &&
    lastActivatedAt > 0
  ) {
    const elapsedDays = Math.max(0, (now - lastActivatedAt) / DAY_MS);
    return clamp(baseStrength - elapsedDays / decayDays, 0, 1);
  }
  const rawStrength = Number(memory.rawStrength);
  return Number.isFinite(rawStrength) ? clamp(rawStrength, 0, 1) : 0;
}

function computeStatus(memory, strength, config) {
  if (memory.rawStatus === 'superseded') return 'superseded';
  if (memory.permanent || isDiaryMemory(memory)) return 'active';
  if (memory.rawStatus === 'archived') return 'archived';
  if (Number.isFinite(strength) && strength <= config.forgetThreshold) return 'faded';
  if (Number.isFinite(strength) && strength < config.fadeThreshold) return 'fading';
  return 'active';
}

function normalizeMemories(rawMemories, { now, config, entitiesById }) {
  const entries = Array.isArray(rawMemories)
    ? rawMemories.map((value, index) => [String(value?.id ?? `mem_${index}`), value])
    : rawMemories && typeof rawMemories === 'object'
      ? Object.entries(rawMemories)
      : [];
  const all = [];
  const seen = new Set();
  let archived = 0;
  let superseded = 0;
  for (const [key, value] of entries) {
    if (!value || typeof value !== 'object') continue;
    const id = String(value.id ?? key ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const layer = value.layer === 'long' ? 'long' : 'short';
    const permanent = value.permanent === true || Number(value.protection) >= 1;
    const decayDays = positiveNumber(
      value.decayDays,
      layer === 'long' ? config.decayDaysLong : config.decayDaysShort,
    );
    const normalized = {
      id,
      layer,
      permanent,
      protection: clampNumber(value.protection, 0, 1, permanent ? 1 : 0),
      category: String(value.category ?? 'other').trim() || 'other',
      title: normalizeNewlines(value.title),
      text: normalizeNewlines(value.text),
      keywords: stringList(value.keywords, { maxItems: 20, maxChars: 30 }),
      tags: stringList(value.tags, { maxItems: 20 }),
      baseStrength: Number.isFinite(Number(value.baseStrength)) ? clamp(Number(value.baseStrength), 0, 1) : 1,
      decayDays,
      createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : 0,
      updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0,
      lastActivatedAt: Number.isFinite(Number(value.lastActivatedAt)) ? Number(value.lastActivatedAt) : 0,
      activationCount: Number.isFinite(Number(value.activationCount)) ? Number(value.activationCount) : 0,
      fadingSince: Number.isFinite(Number(value.fadingSince)) ? Number(value.fadingSince) : 0,
      purgeAfter: Number.isFinite(Number(value.purgeAfter)) ? Number(value.purgeAfter) : 0,
      rawStrength: Number.isFinite(Number(value.strength)) ? clamp(Number(value.strength), 0, 1) : 0,
      rawStatus: value.status === 'archived' ? 'archived' : String(value.status ?? ''),
      source: normalizeSource(value.source),
      recallCount: Array.isArray(value.recallLog) ? value.recallLog.length : 0,
    };
    normalized.diary = isDiaryMemory(normalized);
    normalized.strength = computeStrength(normalized, now);
    normalized.status = computeStatus(normalized, normalized.strength, config);
    if (normalized.status === 'archived') {
      archived += 1;
      continue;
    }
    if (normalized.status === 'superseded') superseded += 1;
    if (!normalized.title) {
      const firstLine = normalized.text.split('\n').find((line) => line.trim()) ?? '';
      normalized.title = truncateChars(firstLine.trim(), 30) || id;
    }
    normalized.entityIds = Array.isArray(value.entityIds)
      ? [...new Set(value.entityIds.map((x) => String(x ?? '').trim()).filter(Boolean))].slice(0, 30)
      : [];
    normalized.entities = normalized.entityIds.map((entityId) => entitiesById.get(entityId)).filter(Boolean);
    normalized.vaultLayer = pickVaultLayer(normalized);
    normalized.firstChar = firstChar(normalized.title);
    all.push(normalized);
  }
  return { all, archived, superseded };
}

function pickVaultLayer(memory) {
  if (memory.diary) return 'long';
  if (memory.status === 'superseded') return 'superseded';
  if (memory.permanent) return 'permanent';
  if (memory.status === 'fading' || memory.status === 'faded') return 'edge';
  return memory.layer === 'long' ? 'long' : 'short';
}

function compareMemories(a, b) {
  const orderA = LAYER_META[a.vaultLayer].order;
  const orderB = LAYER_META[b.vaultLayer].order;
  if (orderA !== orderB) return orderA - orderB;
  if (b.strength !== a.strength) return b.strength - a.strength;
  if (b.lastActivatedAt !== a.lastActivatedAt) return b.lastActivatedAt - a.lastActivatedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareEntities(a, b) {
  const orderA = ENTITY_TYPE_META[a.type].order;
  const orderB = ENTITY_TYPE_META[b.type].order;
  if (orderA !== orderB) return orderA - orderB;
  if (b.mentionCount !== a.mentionCount) return b.mentionCount - a.mentionCount;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function assignUniquePath(used, dir, baseName, fallbackSuffix) {
  let candidate = `${dir}/${baseName}.md`;
  if (!used.has(candidate)) {
    used.set(candidate, 1);
    return candidate;
  }
  const withSuffix = `${dir}/${baseName}-${fallbackSuffix}.md`;
  if (!used.has(withSuffix)) {
    used.set(withSuffix, 1);
    return withSuffix;
  }
  let index = 2;
  while (used.has(`${dir}/${baseName}-${index}.md`)) index += 1;
  candidate = `${dir}/${baseName}-${index}.md`;
  used.set(candidate, 1);
  return candidate;
}

/** 计算每个记忆/实体的 vault 相对路径与 wikilink 目标。 */
function assignPaths(memories, entities) {
  const usedMemoryPaths = new Map();
  for (const memory of memories) {
    if (memory.diary) {
      const baseName = sanitizeFilename(memory.title || memory.id, 60);
      memory.relPath = assignUniquePath(usedMemoryPaths, '日记', baseName, sanitizeFilename(memory.id, 40));
    } else {
      const dir = `记忆/${LAYER_META[memory.vaultLayer].dir}`;
      const baseName = `${sanitizeFilename(memory.id, 40)}-${slugify(memory.title || memory.text, 40)}`;
      memory.relPath = assignUniquePath(usedMemoryPaths, dir, baseName, 'dup');
    }
    memory.linkTarget = memory.relPath.replace(/\.md$/i, '');
    memory.displayTitle = wikiLabel(memory.title || memory.text || memory.id, 60);
  }
  const usedEntityPaths = new Map();
  for (const entity of entities) {
    const dir = `实体/${entity.type}`;
    const baseName = sanitizeFilename(entity.name, 60);
    entity.relPath = assignUniquePath(usedEntityPaths, dir, baseName, sanitizeFilename(entity.id, 40));
    entity.linkTarget = entity.relPath.replace(/\.md$/i, '');
    entity.displayName = wikiLabel(entity.name, 40);
  }
}

function buildStats({ memories, entities, relations, config, archived, superseded = 0, synapses = [], memoriesByLayer, diaries = [] }) {
  const byLayer = { long: 0, short: 0 };
  let fading = 0;
  let faded = 0;
  for (const memory of memories) {
    if (memory.diary) continue;
    byLayer[memory.layer] += 1;
    if (memory.status === 'fading') fading += 1;
    if (memory.status === 'faded') faded += 1;
  }
  return {
    total: memories.length,
    byLayer,
    diary: diaries.length,
    permanent: memoriesByLayer.permanent.length,
    vaultLayers: {
      permanent: memoriesByLayer.permanent.length,
      long: memoriesByLayer.long.length,
      short: memoriesByLayer.short.length,
      edge: memoriesByLayer.edge.length,
      superseded: memoriesByLayer.superseded.length,
    },
    fading,
    faded,
    archived,
    superseded,
    synapses: Array.isArray(synapses) ? synapses.length : 0,
    entities: entities.length,
    relations: relations.length,
    entityTypes: entities.reduce((acc, entity) => {
      acc[entity.type] = (acc[entity.type] ?? 0) + 1;
      return acc;
    }, {}),
    protectionLine: config.protectionLine,
    decayDays: { long: config.decayDaysLong, short: config.decayDaysShort },
    fadeThreshold: config.fadeThreshold,
    forgetThreshold: config.forgetThreshold,
  };
}

/**
 * brain → 渲染模型（纯函数，方便测试/预览）。
 * @param {object} brain §3 定义的 brain.json 内容
 * @param {{now?: number}} [options]
 */
export function buildVaultModel(brain, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const source = brain && typeof brain === 'object' && !Array.isArray(brain) ? brain : {};
  const config = normalizeConfig(source.config);
  const entities = normalizeEntities(source.entities).sort(compareEntities);
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
  const relations = normalizeRelations(source.relations, entitiesById);
  const { all: memories, archived, superseded } = normalizeMemories(source.memories, { now, config, entitiesById });
  memories.sort(compareMemories);
  assignPaths(memories, entities);

  const memoriesByLayer = { permanent: [], long: [], short: [], edge: [], superseded: [] };
  const diaries = [];
  for (const memory of memories) {
    if (memory.diary) {
      diaries.push(memory);
      continue;
    }
    memoriesByLayer[memory.vaultLayer].push(memory);
  }
  diaries.sort(
    (a, b) =>
      String(b.title ?? '').localeCompare(String(a.title ?? '')) ||
      Number(b.createdAt || 0) - Number(a.createdAt || 0),
  );

  const memoriesByEntity = new Map();
  for (const memory of memories) {
    for (const entity of memory.entities) {
      if (!memoriesByEntity.has(entity.id)) memoriesByEntity.set(entity.id, []);
      memoriesByEntity.get(entity.id).push(memory);
    }
  }

  // 实体所在类型（用于主页/README 展示与 SVG 分簇），按固定顺序。
  const entityTypes = ENTITY_TYPE_ORDER.filter((type) => entities.some((entity) => entity.type === type)).map(
    (type) => ({ type, ...ENTITY_TYPE_META[type], count: entities.filter((entity) => entity.type === type).length }),
  );
  const relationsByEntity = new Map();
  for (const relation of relations) {
    if (!relationsByEntity.has(relation.from)) relationsByEntity.set(relation.from, []);
    if (!relationsByEntity.has(relation.to)) relationsByEntity.set(relation.to, []);
    relationsByEntity.get(relation.from).push({ direction: 'out', relation });
    relationsByEntity.get(relation.to).push({ direction: 'in', relation });
  }

  const stats = buildStats({ memories, entities, relations, config, archived, superseded, synapses: source.synapses, memoriesByLayer, diaries });
  const memoryIdSet = new Set(memories.map((memory) => memory.id));
  const synapses = (Array.isArray(source.synapses) ? source.synapses : [])
    .map((synapse) => ({
      id: String(synapse?.id ?? ''),
      from: String(synapse?.from ?? ''),
      to: String(synapse?.to ?? ''),
      weight: Number(synapse?.weight) || 0.3,
      coactivations: Number(synapse?.coactivations) || 0,
    }))
    .filter((synapse) => memoryIdSet.has(synapse.from) && memoryIdSet.has(synapse.to) && synapse.from !== synapse.to);
  return {
    now,
    config,
    protectionLine: config.protectionLine,
    decayDays: { long: config.decayDaysLong, short: config.decayDaysShort },
    fadeThreshold: config.fadeThreshold,
    forgetThreshold: config.forgetThreshold,
    memories,
    memoriesByLayer,
    diaries,
    memoriesByEntity,
    entities,
    entitiesById,
    relations,
    relationsByEntity,
    synapses,
    entityTypes,
    stats,
    createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : 0,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : 0,
  };
}

// ---------------------------------------------------------------------------
// Markdown 生成
// ---------------------------------------------------------------------------

function layerBadge(memory) {
  if (memory.diary) return '日记';
  return LAYER_META[memory.vaultLayer].shortLabel;
}

function strengthLine(model, memory) {
  return `${progressBar(memory.strength)} ${percent(memory.strength)}（保护线 ${percent(model.protectionLine)}）`;
}

function decayDescription(model, memory) {
  if (memory.diary) return '日记：单独归档在 `日记/`，不参与衰减，也不会被清理。';
  if (memory.status === 'superseded') {
    return '已被新的决策/事实取代（v1.3 矛盾降权）：默认召回不再返回，保留作为时间线记录。';
  }
  if (memory.permanent) return '永久保留（protection = 1），不参与衰减，也不会被遗忘。';
  const remainingDays = Math.ceil(memory.strength * memory.decayDays);
  const lastActive = formatUtc(memory.lastActivatedAt);
  if (memory.status === 'faded') {
    return `${memory.decayDays} 天线性衰减，强度已归零（${percent(memory.strength)}），等待清理；再提起可唤醒。`;
  }
  if (memory.status === 'fading') {
    return `${memory.decayDays} 天线性衰减，只剩 ${percent(
      memory.strength,
    )}（低于淡忘阈值 ${percent(model.fadeThreshold)}），约 ${remainingDays} 天后归零；再提起可唤醒。`;
  }
  return `${memory.decayDays} 天线性衰减，上次激活 ${lastActive}，约 ${remainingDays} 天后归零。`;
}

function memoryEntityLines(memory) {
  if (memory.entities.length === 0) return ['_（这条记忆还没有关联实体）_'];
  return memory.entities.map(
    (entity) => `- [[${entity.linkTarget}|${entity.displayName}]]（${ENTITY_TYPE_META[entity.type].label}）`,
  );
}

function sourceLines(memory) {
  const source = memory.source;
  if (!source) return ['_（无来源信息）_'];
  const lines = [];
  if (source.kind) lines.push(`- 类型：\`${source.kind}\``);
  if (source.key) lines.push(`- 会话：\`${source.key}\``);
  if (source.seqs) lines.push(`- 消息 seq：${source.seqs.join(', ')}`);
  if (source.createdBy) lines.push(`- 创建者：\`${source.createdBy}\``);
  return lines;
}

function memoryFrontmatter(memory) {
  return {
    id: memory.id,
    title: memory.title,
    layer: memory.layer,
    ...(memory.diary ? { diary: true } : {}),
    protection: memory.protection,
    strength: Math.round(memory.strength * 10000) / 10000,
    status: memory.status,
    category: memory.category,
    decayDays: memory.decayDays,
    permanent: memory.permanent,
    created: toIso(memory.createdAt),
    updated: toIso(memory.updatedAt),
    lastActivated: toIso(memory.lastActivatedAt),
    entities: memory.entities.map((entity) => entity.name),
    tags: memory.tags,
    source: memory.source,
  };
}

function buildMemoryNote(model, memory) {
  const meta = LAYER_META[memory.vaultLayer];
  const lines = [toFrontmatter(memoryFrontmatter(memory))];

  if (memory.vaultLayer === 'edge') {
    lines.push(`# ${memory.firstChar}…`, '');
    lines.push(`${memory.firstChar}…`, '');
    lines.push(
      `> [!warning] 这片记忆正在淡忘（强度 ${percent(memory.strength)}，低于淡忘阈值 ${percent(
        model.fadeThreshold,
      )}）`,
      '> 有人再提起时 bot 会 `memory touch` 重新激活它；持续无人提起就会彻底消失。',
      '',
    );
  } else {
    lines.push(`# ${memory.title}`, '');
    lines.push(memory.text || '_（没有正文）_', '');
  }

  lines.push('## 强度', '', strengthLine(model, memory), '');
  lines.push(`- 状态：\`${memory.status}\`（${statusLabel(memory.status)}）`);
  lines.push(
    memory.diary
      ? '- 层级：**日记**（单独归档，不参与衰减与清理）'
      : `- 层级：**${meta.label}**（${meta.description}）`,
  );
  lines.push(`- 衰减：${decayDescription(model, memory)}`);
  lines.push(
    `- 保护：${
      memory.permanent
        ? '永久保留'
        : memory.diary
          ? '日记（tags 含 diary，单独归档）'
          : `protection = ${memory.protection}（非永久）`
    }`,
  );
  lines.push(`- 激活次数：${memory.activationCount}${memory.recallCount > 0 ? ` · 召回记录 ${memory.recallCount} 条` : ''}`);
  if (memory.keywords.length > 0) lines.push(`- 关键词：${memory.keywords.join('、')}`);
  lines.push('');

  lines.push('## 实体', '', ...memoryEntityLines(memory), '');
  lines.push('## 来源', '', ...sourceLines(memory), '');

  if (memory.vaultLayer === 'edge') {
    lines.push(
      '<details><summary>残片里的完整记忆（点击展开）</summary>',
      '',
      `**原标题**：${memory.title}`,
      '',
      memory.text || '_（没有正文）_',
      '',
      '</details>',
      '',
    );
  }

  lines.push('---', '', `生成于 ${formatUtc(model.now)} · vault v${VAULT_VERSION} · ${HTML_BANNER}`, '');
  return lines.join('\n');
}

function statusLabel(status) {
  if (status === 'active') return '稳定';
  if (status === 'fading') return '淡忘中';
  if (status === 'faded') return '已淡出';
  if (status === 'archived') return '已归档';
  if (status === 'superseded') return '已取代（默认不召回）';
  return status;
}

function buildEntityNote(model, entity) {
  const typeMeta = ENTITY_TYPE_META[entity.type];
  const frontmatter = {
    id: entity.id,
    type: entity.type,
    name: entity.name,
    aliases: entity.aliases,
    mentionCount: entity.mentionCount,
    tags: entity.tags,
    firstSeen: toIso(entity.firstSeenAt),
    lastMentioned: toIso(entity.lastMentionedAt),
    created: toIso(entity.createdAt),
    updated: toIso(entity.updatedAt),
    source: entity.source,
  };
  const lines = [toFrontmatter(frontmatter)];
  lines.push(`# ${entity.name}`, '');
  lines.push(`> ${typeMeta.label} · 提及 ${entity.mentionCount} 次 · 别名：${entity.aliases.length > 0 ? entity.aliases.join('、') : '无'}`, '');
  if (entity.note) lines.push(entity.note, '');

  const relatedRelations = model.relationsByEntity.get(entity.id) ?? [];
  lines.push(`## 关系（${relatedRelations.length}）`, '');
  if (relatedRelations.length === 0) {
    lines.push('_（知识图谱里还没有关系）_');
  } else {
    for (const { direction, relation } of relatedRelations) {
      if (direction === 'out') {
        lines.push(
          `- **${relationLabelOf(relation.relation)}${relation.relation !== relationLabelOf(relation.relation) ? `（${relation.relation}）` : ''}** → [[${relation.toEntity.linkTarget}|${relation.toEntity.displayName}]]（权重 ${relation.weight}）`,
        );
      } else {
        lines.push(
          `- **${relationLabelOf(relation.relation)}${relation.relation !== relationLabelOf(relation.relation) ? `（${relation.relation}）` : ''}** ← [[${relation.fromEntity.linkTarget}|${relation.fromEntity.displayName}]]（权重 ${relation.weight}）`,
        );
      }
    }
  }
  lines.push('');

  const relatedMemories = model.memoriesByEntity.get(entity.id) ?? [];
  lines.push(`## 关联记忆（${relatedMemories.length}）`, '');
  if (relatedMemories.length === 0) {
    lines.push('_（还没有关联的记忆）_');
  } else {
    for (const memory of relatedMemories.slice(0, ENTITY_MEMORY_LIMIT)) {
      lines.push(
        `- [[${memory.linkTarget}|${memory.displayTitle}]]（${layerBadge(memory)} · 强度 ${percent(memory.strength)}）`,
      );
    }
    if (relatedMemories.length > ENTITY_MEMORY_LIMIT) {
      lines.push(`- …另有 ${relatedMemories.length - ENTITY_MEMORY_LIMIT} 条关联记忆`);
    }
  }
  lines.push('');
  lines.push('---', '', `生成于 ${formatUtc(model.now)} · vault v${VAULT_VERSION} · ${HTML_BANNER}`, '');
  return lines.join('\n');
}

function listMemoryLinks(memories, limit = HOME_LIST_LIMIT) {
  const lines = [];
  for (const memory of memories.slice(0, limit)) {
    const strength = memory.vaultLayer === 'edge' ? `${memory.firstChar}…` : percent(memory.strength);
    lines.push(`- [[${memory.linkTarget}|${memory.displayTitle}]] · ${strength} · ${statusLabel(memory.status)}`);
  }
  return lines;
}

function buildHomePage(model) {
  const stats = model.stats;
  const lines = [HTML_BANNER, '', '# 🧠 记忆大脑', ''];
  lines.push(`> 这是 **QQ Bridge 记忆系统** 的 Obsidian 主页（vault v${VAULT_VERSION}）。`);
  lines.push('> 全部内容由 `src/memory/vault.mjs` 自动生成，手改会被下一次刷新覆盖。', '');
  lines.push('![[图谱/记忆大脑.svg]]', '');
  lines.push('- 交互式图谱：[[图谱/记忆大脑.canvas|打开 记忆大脑.canvas]]');
  lines.push('- 使用说明：[[README|README]]');
  lines.push('- 颜色约定：永久 = 金色 · 长期 = 蓝色 · 短期 = 灰色 · 边缘 = 暗色 · 实体 = 绿色', '');

  const topology = topologySummary(model);
  if (topology.length > 0) {
    lines.push('### 🧭 分域拓扑', '');
    for (const scope of topology) {
      lines.push(`- [[${scope.svgPath}|${scope.title}]] · [[${scope.canvasPath}|Canvas]]（节点 ${scope.nodes} · 连线 ${scope.edges}）`);
    }
    lines.push('');
  }

  lines.push('## 📊 统计', '', '| 项目 | 数值 |', '| --- | --- |');
  lines.push(`| 记忆总数 | ${stats.total} |`);
  lines.push(`| 🟡 永久记忆 | ${stats.vaultLayers.permanent} |`);
  lines.push(`| 🔵 长期记忆 | ${stats.vaultLayers.long} |`);
  lines.push(`| ⚪ 短期记忆 | ${stats.vaultLayers.short} |`);
  lines.push(`| 🌑 边缘记忆 | ${stats.vaultLayers.edge}（淡忘中 ${stats.fading} / 已淡出 ${stats.faded}） |`);
  lines.push(`| 📔 日记（单独归档） | ${stats.diary} |`);
  lines.push(`| 实体 | ${stats.entities} |`);
  lines.push(`| 关系 | ${stats.relations} |`);
  lines.push(`| 保护线 | ${percent(stats.protectionLine)} |`);
  lines.push(`| 衰减周期 | 长期 ${stats.decayDays.long} 天 / 短期 ${stats.decayDays.short} 天 |`);
  lines.push(`| 生成时间 | ${formatUtc(model.now)} |`, '');

  lines.push('## 🔑 保护线与衰减', '');
  lines.push(
    `- **保护线 ${percent(stats.protectionLine)}**：强度 ≥ ${percent(
      stats.protectionLine,
    )} 的记忆还在「核心区」，低于它就会慢慢漂向边缘；保护线只影响展示与排序，不阻止衰减。`,
  );
  lines.push('- **永久记忆**：保护值 = 1 的记忆，永不衰减、永不清理，永远留在中心。');
  lines.push('- **日记**：tags 含 `diary` 的记忆单独归档在 `日记/`，不参与衰减、不会被清理，也不会占用四层记忆的位置。');
  lines.push('- **衰减公式**：强度 = 基准强度 − 已过天数 ÷ 衰减周期，线性归零；重复提起（recall/touch）会重置回 100%。');
  lines.push(
    `- **遗忘**：强度 < ${percent(stats.fadeThreshold)} 变「边缘」（只显示首字残片），强度 ≤ ${percent(
      stats.forgetThreshold,
    )} 变「已淡出」，之后会被清理。`,
    '',
  );

  const sections = [
    ['🟡 永久记忆', 'permanent', '记忆/永久'],
    ['🔵 长期记忆', 'long', '记忆/长期'],
    ['⚪ 短期记忆', 'short', '记忆/短期'],
    ['🌑 边缘记忆', 'edge', '记忆/边缘'],
  ];
  for (const [title, layerKey, dir] of sections) {
    const memories = model.memoriesByLayer[layerKey];
    lines.push(`## ${title}（${memories.length}）`, '');
    if (memories.length === 0) {
      lines.push(`_（暂无；目录 \`${dir}/\`）_`, '');
    } else {
      lines.push(...listMemoryLinks(memories));
      if (memories.length > HOME_LIST_LIMIT) {
        lines.push(`- …另有 ${memories.length - HOME_LIST_LIMIT} 条，见 \`${dir}/\` 目录`);
      }
      lines.push('');
    }
  }

  lines.push(`## 📔 日记（${stats.diary}）`, '');
  if (model.diaries.length === 0) {
    lines.push('_（暂无日记；写日记用 `mcp__memory__remember` 并带 tags `["diary"]`，标题「日记·YYYY-MM-DD」）_', '');
  } else {
    for (const memory of model.diaries.slice(0, 30)) {
      lines.push(`- [[${memory.linkTarget}|${memory.displayTitle}]] · ${formatUtc(memory.createdAt)}`);
    }
    if (model.diaries.length > 30) {
      lines.push(`- …另有 ${model.diaries.length - 30} 篇，见 \`日记/\` 目录`);
    }
    lines.push('');
  }

  lines.push(`## 🕸 实体（${stats.entities}）`, '');
  if (model.entityTypes.length === 0) {
    lines.push('_（暂无实体）_', '');
  } else {
    for (const typeInfo of model.entityTypes) {
      const items = model.entities
        .filter((entity) => entity.type === typeInfo.type)
        .slice(0, 20)
        .map((entity) => `[[${entity.linkTarget}|${entity.displayName}]]`);
      lines.push(`- **${typeInfo.label}（${typeInfo.count}）**：${items.join('、') || '—'}`);
    }
    lines.push('');
  }

  lines.push('## 🕰 最近激活', '');
  const recent = [...model.memories]
    .filter((memory) => memory.lastActivatedAt > 0)
    .sort((a, b) => b.lastActivatedAt - a.lastActivatedAt)
    .slice(0, 10);
  if (recent.length === 0) {
    lines.push('_（暂无激活记录）_');
  } else {
    for (const memory of recent) {
      lines.push(`- ${formatUtc(memory.lastActivatedAt)} · [[${memory.linkTarget}|${memory.displayTitle}]]`);
    }
  }
  lines.push('');
  lines.push('---', '', `自动生成于 ${formatUtc(model.now)} · vault v${VAULT_VERSION}`, '');
  return lines.join('\n');
}

function buildReadme(model) {
  const stats = model.stats;
  const lines = [HTML_BANNER, '', '# QQ Bridge 记忆大脑 vault', ''];
  lines.push('> 这是 QQ Bridge 机器人的长期记忆在 Obsidian 里的可读副本。');
  lines.push(`> vault 结构版本 v${VAULT_VERSION}，由 \`src/memory/vault.mjs\` 生成，**手改会被下一次刷新覆盖**。`, '');

  lines.push('## 如何打开', '');
  lines.push('1. 打开 Obsidian →「打开文件夹作为 vault」→ 选择本目录（默认 `state/memory-vault`）。');
  lines.push('2. 打开 [[00-记忆大脑]] 看总览、统计与 SVG 大脑图。');
  lines.push('3. 打开 [[图谱/记忆大脑.canvas|记忆大脑 Canvas]] 看可缩放的知识图谱。');
  lines.push('4. 分域拓扑：[[图谱/拓扑-群聊.svg|群聊拓扑]] · [[图谱/拓扑-私信.svg|私信拓扑]] · [[图谱/拓扑-黑话.svg|黑话拓扑]]（对应 `.canvas` 可拖动）。');
  lines.push('5. 按 `Ctrl/Cmd + G` 打开 Graph View 看颜色分组（永久金 / 长期蓝 / 短期灰 / 实体绿 / 边缘暗）。', '');

  lines.push('## 目录结构', '');
  lines.push('```text');
  lines.push('00-记忆大脑.md          # 主页：统计、导航、嵌入 SVG');
  lines.push('README.md               # 本说明');
  lines.push('记忆/永久/              # protection = 1，永不衰减');
  lines.push('记忆/长期/              # layer = long，默认 200 天衰减');
  lines.push('记忆/短期/              # layer = short，默认 30 天衰减');
  lines.push('记忆/边缘/              # fading / faded，只剩首字残片');
  lines.push('日记/                   # tags 含 diary 的日记，单独归档；不参与衰减/清理');
  lines.push('实体/<type>/            # person / group / topic / term / event / project / self');
  lines.push('图谱/记忆大脑.canvas    # Obsidian Canvas（同心圆布局）');
  lines.push('图谱/记忆大脑.svg       # 大脑可视化（1600×1000，确定性生成）');
  lines.push('图谱/拓扑-群聊.svg      # 分域图：QQ 群 + 群友 + 群聊记忆');
  lines.push('图谱/拓扑-私信.svg      # 分域图：owner + 私信话题 + 私信记忆');
  lines.push('图谱/拓扑-黑话.svg      # 分域图：黑话词条 + 使用它们的人');
  lines.push('图谱/拓扑-*.canvas      # 分域图的可拖动 Canvas 版本');
  lines.push('.obsidian/              # Graph View 颜色组等最小配置');
  lines.push('```', '');

  lines.push('## 颜色含义', '', '| 颜色 | 含义 | 位置 |', '| --- | --- | --- |');
  lines.push('| 🟡 金 | 永久记忆（protection = 1，不衰减） | 中心内圈 / `记忆/永久/` |');
  lines.push('| 🔵 蓝 | 长期记忆（200 天衰减） | 中圈 / `记忆/长期/` |');
  lines.push('| ⚪ 灰 | 短期记忆（30 天衰减） | 外圈 / `记忆/短期/` |');
  lines.push('| 🌑 暗 | 边缘记忆（fading / faded，只剩残片） | 最外圈 / `记忆/边缘/` |');
  lines.push('| 🟢 绿 | 实体节点（人物 / 群 / 话题 / 术语 / 事件 / 项目 / 自我） | 实体分簇 / `实体/` |', '');

  lines.push('## 记忆怎么读', '');
  lines.push(`- 每条记忆笔记的 frontmatter 有 \`id / layer / protection / strength / status / category / decayDays / created / updated / lastActivated / entities / tags / source\`。`);
  lines.push('- 正文里的十格进度条 = 当前强度：`█████░░░░░` 就是 50%。');
  lines.push(`- **保护线 ${percent(stats.protectionLine)}**：强度在保护线以上算「核心区」；保护线只影响展示权重，不阻止衰减。`);
  lines.push('- 只有 **保护值 = 1** 的记忆永久保留；其余记忆按 `decayDays` 线性衰减到 0 后被清理。');
  lines.push(`- 强度 < ${percent(stats.fadeThreshold)} 的记忆会进入 \`记忆/边缘/\`，只显示一个字 + \`…\`；点开笔记可以展开原始内容。`);
  lines.push('- 重复提起（recall / touch）会把强度重置回 100%，重新开始计时。');
  lines.push('- **日记**（tags 含 `diary`）单独放在 `日记/`，不参与衰减与清理；标题统一「日记·YYYY-MM-DD」，可用 `search --date` 按日期检索。', '');

  lines.push('## 如何刷新', '');
  lines.push('```bash');
  lines.push('# 默认读 state/memory/brain.json，写到 state/memory-vault/');
  lines.push('node scripts/memory-vault-refresh.mjs');
  lines.push('');
  lines.push('# 指定来源与目标（测试/迁移时用）');
  lines.push('node scripts/memory-vault-refresh.mjs --brain path/to/brain.json --vault path/to/vault');
  lines.push('');
  lines.push('# 输出 JSON 统计（给每日维护脚本用）');
  lines.push('node scripts/memory-vault-refresh.mjs --json');
  lines.push('```', '');
  lines.push('Windows 上若 PATH 里没有 `node`，用 `D:\\node.exe scripts/memory-vault-refresh.mjs`。', '');

  lines.push('## 注意', '');
  lines.push('- 本 vault 里 `记忆/`、`实体/` 的旧 `.md` 每次刷新都会被重建；**vault 根目录的其他笔记、附件不会被删除或修改**。');
  lines.push(`- Canvas 与 SVG 是「示意图」：记忆超过上限时按强度取前 N 个显示（当前记忆 ${stats.total} 条，完整清单看目录里的 Markdown 笔记）。`);
  lines.push('- 想改记忆内容请让 bot 调 `mcp__memory__update` / `remember`，或先备份 `brain.json` 再手改，不要直接改本 vault。');
  lines.push('- 想重新生成：跑上面的刷新命令，或在每日维护（`scripts/memory-maintenance.mjs --vault`）里自动刷新。', '');
  lines.push('---', '', `自动生成于 ${formatUtc(model.now)} · vault v${VAULT_VERSION}`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Canvas（Obsidian Canvas JSON）
// ---------------------------------------------------------------------------

function canvasSelection(model) {
  const selected = {};
  const hidden = {};
  for (const layerKey of LAYER_ORDER) {
    const all = model.memoriesByLayer[layerKey];
    selected[layerKey] = all.slice(0, CANVAS_CAPS[layerKey]);
    hidden[layerKey] = all.length - selected[layerKey].length;
  }
  const entities = model.entities.slice(0, CANVAS_CAPS.entities);
  return {
    memories: LAYER_ORDER.flatMap((layerKey) => selected[layerKey]),
    selected,
    hidden,
    entities,
    hiddenEntities: model.entities.length - entities.length,
  };
}

function sideOfAngle(angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  if (Math.abs(cos) >= Math.abs(sin)) return cos >= 0 ? 'right' : 'left';
  return sin >= 0 ? 'bottom' : 'top';
}

function oppositeSide(side) {
  if (side === 'left') return 'right';
  if (side === 'right') return 'left';
  if (side === 'top') return 'bottom';
  return 'top';
}

/** 两个节点连线时选择最贴近的边（Canvas 的 fromSide/toSide）。 */
function nodeSidesBetween(fromNode, toNode) {
  const dx = toNode.x + toNode.width / 2 - (fromNode.x + fromNode.width / 2);
  const dy = toNode.y + toNode.height / 2 - (fromNode.y + fromNode.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

function canvasLayerRadius(count, layerKey, previousRadius) {
  const need = count > 0 ? (count * 290) / (2 * Math.PI) : 0;
  const minimums = { permanent: 460, long: 820, short: 1180, edge: 1440, superseded: 1700 };
  return Math.max(minimums[layerKey], need, previousRadius + 330);
}

function canvasAngleStart(layerKey) {
  const offsets = { permanent: 15, long: 8, short: 3, edge: 0, superseded: 0 };
  return (-90 + offsets[layerKey]) * (Math.PI / 180);
}

function truncateCanvasTitle(title) {
  return truncateLabel(title, 14);
}

function buildCanvas(model) {
  const selection = canvasSelection(model);
  const nodes = [];
  const edges = [];
  const stats = model.stats;

  const centerText = [
    '🧠 **记忆大脑**',
    '自动生成，手改会被覆盖',
    `永久 ${stats.vaultLayers.permanent} · 长期 ${stats.vaultLayers.long} · 短期 ${stats.vaultLayers.short} · 边缘 ${stats.vaultLayers.edge}`,
    `实体 ${stats.entities} · 关系 ${stats.relations}`,
  ];
  const totalHidden = Object.values(selection.hidden).reduce((a, b) => a + b, 0) + selection.hiddenEntities;
  if (totalHidden > 0) centerText.push(`（另有 ${totalHidden} 个节点未在图中显示，完整清单见 Markdown 目录）`);
  nodes.push({
    id: 'center-brain',
    type: 'text',
    text: centerText.join('\n'),
    x: -190,
    y: -95,
    width: 380,
    height: 190,
    color: LAYER_META.permanent.canvasColor,
  });

  const nodeIdByMemoryId = new Map();
  const nodeIdByEntityId = new Map();
  const memoryAngles = new Map();
  let previousRadius = 0;

  for (const layerKey of LAYER_ORDER) {
    const memories = selection.selected[layerKey];
    const radius = canvasLayerRadius(memories.length, layerKey, previousRadius);
    previousRadius = radius;
    const startAngle = canvasAngleStart(layerKey);
    memories.forEach((memory, index) => {
      const step = (Math.PI * 2) / Math.max(1, memories.length);
      const angle = startAngle + index * step;
      const drift = layerKey === 'permanent' ? 0 : (1 - memory.strength) * 90;
      const ringRadius = radius + drift;
      const nodeId = `node-${memory.id}`;
      nodeIdByMemoryId.set(memory.id, nodeId);
      memoryAngles.set(memory.id, angle);
      nodes.push({
        id: nodeId,
        type: 'text',
        text: `**${truncateCanvasTitle(memory.title)}**\n${layerBadge(memory)} · 强度 ${percent(
          memory.strength,
        )}\n[[${memory.linkTarget}|打开笔记]]`,
        x: Math.round(ringRadius * Math.cos(angle) - 115),
        y: Math.round(ringRadius * Math.sin(angle) - 55),
        width: 230,
        height: 110,
        ...(LAYER_META[layerKey].canvasColor ? { color: LAYER_META[layerKey].canvasColor } : {}),
      });
    });
  }

  // 实体按类型分簇，放在最外圈。
  const entityCount = selection.entities.length;
  const entityRadius = Math.max(
    previousRadius + 480,
    entityCount > 0 ? (entityCount * 300) / (2 * Math.PI) : 0,
    1860,
  );
  const typeGroups = ENTITY_TYPE_ORDER.filter((type) =>
    selection.entities.some((entity) => entity.type === type),
  ).map((type) => selection.entities.filter((entity) => entity.type === type));
  let typeStart = -Math.PI / 2;
  for (const group of typeGroups) {
    const span = entityCount > 0 ? (Math.PI * 2 * group.length) / entityCount : 0;
    group.forEach((entity, index) => {
      const angle = typeStart + (span * (index + 0.5)) / Math.max(1, group.length);
      const nodeId = `node-${entity.id}`;
      nodeIdByEntityId.set(entity.id, nodeId);
      nodes.push({
        id: nodeId,
        type: 'text',
        text: `**${truncateLabel(entity.name, 16)}**\n${ENTITY_TYPE_META[entity.type].label} · 提及 ${
          entity.mentionCount
        } 次\n[[${entity.linkTarget}|打开]]`,
        x: Math.round(entityRadius * Math.cos(angle) - 105),
        y: Math.round(entityRadius * Math.sin(angle) - 45),
        width: 210,
        height: 90,
        color: '4',
      });
    });
    typeStart += span;
  }

  // 边：中心 → 记忆节点。
  for (const memory of selection.memories) {
    const nodeId = nodeIdByMemoryId.get(memory.id);
    if (!nodeId) continue;
    const angle = memoryAngles.get(memory.id) ?? 0;
    const fromSide = sideOfAngle(angle);
    edges.push({
      id: `edge-center-${memory.id}`,
      fromNode: 'center-brain',
      fromSide,
      toNode: nodeId,
      toSide: oppositeSide(fromSide),
      ...(LAYER_META[memory.vaultLayer].canvasColor
        ? { color: LAYER_META[memory.vaultLayer].canvasColor }
        : {}),
    });
  }

  // 边：记忆 ↔ 实体（每条记忆最多连 3 个实体，总上限防爆炸）。
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  let memoryEntityEdges = 0;
  for (const memory of selection.memories) {
    if (memoryEntityEdges >= CANVAS_MAX_MEMORY_ENTITY_EDGES) break;
    let linked = 0;
    for (const entity of memory.entities) {
      const entityNodeId = nodeIdByEntityId.get(entity.id);
      const memoryNodeId = nodeIdByMemoryId.get(memory.id);
      if (!entityNodeId || !memoryNodeId) continue;
      const fromNode = nodeById.get(memoryNodeId);
      const toNode = nodeById.get(entityNodeId);
      if (!fromNode || !toNode) continue;
      const [fromSide, toSide] = nodeSidesBetween(fromNode, toNode);
      edges.push({
        id: `edge-mem-${memory.id}-${entity.id}`,
        fromNode: memoryNodeId,
        fromSide,
        toNode: entityNodeId,
        toSide,
      });
      linked += 1;
      memoryEntityEdges += 1;
      if (linked >= 3 || memoryEntityEdges >= CANVAS_MAX_MEMORY_ENTITY_EDGES) break;
    }
  }

  // 边：实体 ↔ 实体（带关系名）。
  let relationIndex = 0;
  for (const relation of model.relations) {
    const fromNodeId = nodeIdByEntityId.get(relation.from);
    const toNodeId = nodeIdByEntityId.get(relation.to);
    if (!fromNodeId || !toNodeId) continue;
    const fromNode = nodeById.get(fromNodeId);
    const toNode = nodeById.get(toNodeId);
    if (!fromNode || !toNode) continue;
    const [fromSide, toSide] = nodeSidesBetween(fromNode, toNode);
    edges.push({
      id: `edge-rel-${relationIndex}-${relation.id}`,
      fromNode: fromNodeId,
      fromSide,
      toNode: toNodeId,
      toSide,
      label: relationLabelOf(relation.relation),
      color: '2',
    });
    relationIndex += 1;
  }

  // 边：v1.3 Hebbian 共激活突触（同轮召回一起出现过的记忆之间）。
  let synapseIndex = 0;
  for (const synapse of model.synapses || []) {
    const fromNodeId = nodeIdByMemoryId.get(String(synapse.from));
    const toNodeId = nodeIdByMemoryId.get(String(synapse.to));
    if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) continue;
    const fromNode = nodeById.get(fromNodeId);
    const toNode = nodeById.get(toNodeId);
    if (!fromNode || !toNode) continue;
    const [fromSide, toSide] = nodeSidesBetween(fromNode, toNode);
    edges.push({
      id: `edge-syn-${synapseIndex}`,
      fromNode: fromNodeId,
      fromSide,
      toNode: toNodeId,
      toSide,
      label: '共激活',
      color: '4',
    });
    synapseIndex += 1;
  }

  // 图例节点放在整张图最下方。
  let minX = Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    maxY = Math.max(maxY, node.y + node.height);
  }
  if (!Number.isFinite(minX)) minX = -190;
  if (!Number.isFinite(maxY)) maxY = 95;
  nodes.push({
    id: 'node-legend',
    type: 'text',
    text: '**图例**\n🟡 永久记忆 · 🔵 长期记忆 · ⚪ 短期记忆\n🌑 边缘残片 · 🟣 已取代 · 🟢 实体 · 紫线=共激活突触\n自动生成，手改会被覆盖',
    x: Math.round(minX),
    y: Math.round(maxY + 120),
    width: 380,
    height: 130,
  });

  return {
    json: `${JSON.stringify({ nodes, edges }, null, 2)}\n`,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      displayedMemories: selection.memories.length,
      totalMemories: model.memories.length,
      displayedEntities: selection.entities.length,
      totalEntities: model.entities.length,
      hiddenMemories: model.memories.length - selection.memories.length,
      hiddenEntities: selection.hiddenEntities,
    },
  };
}

// ---------------------------------------------------------------------------
// SVG（仿参考图的大脑/神经元可视化，1600×1000，确定性）
// ---------------------------------------------------------------------------

const SVG = Object.freeze({
  width: 1600,
  height: 1000,
  cx: 800,
  cy: 540,
  syncRadius: 108,
  brainRadius: 84,
  bands: {
    permanent: { inner: 128, outer: 162 },
    long: { inner: 192, outer: 240 },
    short: { inner: 268, outer: 306 },
    edge: { inner: 330, outer: 356 },
    superseded: { inner: 366, outer: 388 },
  },
  entityRx: 640,
  entityRy: 378,
  colors: {
    background: '#F7F9FC',
    grid: '#E3E9F2',
    guide: '#DDE5F0',
    text: '#1F2937',
    muted: '#64748B',
    faint: '#94A3B8',
    brainFill: '#EEF3FB',
    brainStroke: '#8FA0BF',
    brainLine: '#91A2C0',
    centerGlow: '#FDF6E3',
  },
});

function selectSvgMemories(model) {
  const selected = {};
  for (const layerKey of LAYER_ORDER) {
    selected[layerKey] = model.memoriesByLayer[layerKey].slice(0, SVG_CAPS[layerKey]);
  }
  return selected;
}

function svgRingGeometry(layerKey, count, layerIndex) {
  const band = SVG.bands[layerKey];
  const start = (-90 + ([18, 9, 5, 0, -3][layerIndex] ?? 0)) * (Math.PI / 180);
  const step = count > 0 ? (Math.PI * 2) / count : Math.PI * 2;
  return { band, start, step };
}

function buildSvg(model, { memoriesByLayer } = {}) {
  const selected = memoriesByLayer ?? selectSvgMemories(model);
  const nodes = [];

  // 记忆点（先算好坐标，供实体连线复用）。
  const bandPositions = {};
  LAYER_ORDER.forEach((layerKey, layerIndex) => {
    const list = selected[layerKey];
    const { band, start, step } = svgRingGeometry(layerKey, list.length, layerIndex);
    bandPositions[layerKey] = list.map((memory, index) => {
      const angle = start + index * step;
      const radius = band.outer - memory.strength * (band.outer - band.inner);
      const x = SVG.cx + radius * Math.cos(angle);
      const y = SVG.cy + radius * Math.sin(angle);
      return { memory, angle, radius, x, y };
    });
  });

  // 实体节点（类型分簇，角度按数量分配）。
  const entities = model.entities.slice(0, SVG_CAPS.entities);
  const entityPositions = new Map();
  const typeGroups = ENTITY_TYPE_ORDER.filter((type) =>
    entities.some((entity) => entity.type === type),
  ).map((type) => entities.filter((entity) => entity.type === type));
  let typeStart = -Math.PI / 2;
  for (const group of typeGroups) {
    const span = entities.length > 0 ? (Math.PI * 2 * group.length) / entities.length : 0;
    group.forEach((entity, index) => {
      const angle = typeStart + (span * (index + 0.5)) / Math.max(1, group.length);
      entityPositions.set(entity.id, {
        entity,
        angle,
        x: SVG.cx + SVG.entityRx * Math.cos(angle),
        y: SVG.cy + SVG.entityRy * Math.sin(angle),
      });
    });
    typeStart += span;
  }

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(HTML_BANNER);
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG.width}" height="${SVG.height}" viewBox="0 0 ${SVG.width} ${SVG.height}" role="img" aria-label="QQ Bridge 记忆大脑">`,
  );

  // ---- defs ----
  lines.push('  <defs>');
  lines.push(
    `    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="${SVG.colors.grid}" stroke-width="1"/></pattern>`,
  );
  lines.push(
    `    <radialGradient id="centerGlow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${SVG.colors.centerGlow}" stop-opacity="0.95"/><stop offset="70%" stop-color="${SVG.colors.centerGlow}" stop-opacity="0.35"/><stop offset="100%" stop-color="${SVG.colors.centerGlow}" stop-opacity="0"/></radialGradient>`,
  );
  lines.push(
    '    <filter id="goldGlow" x="-120%" y="-120%" width="340%" height="340%"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
  );
  lines.push(
    '    <filter id="brainShadow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="7" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
  );
  lines.push(
    `    <marker id="syncArrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${SVG.colors.faint}"/></marker>`,
  );
  lines.push('  </defs>');

  // ---- 背景 + 网格 ----
  lines.push(`  <rect width="${SVG.width}" height="${SVG.height}" fill="${SVG.colors.background}"/>`);
  lines.push(`  <rect width="${SVG.width}" height="${SVG.height}" fill="url(#grid)"/>`);

  // ---- 标题 ----
  lines.push(
    `  <text x="${SVG.cx}" y="52" text-anchor="middle" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" font-size="36" font-weight="700" fill="${SVG.colors.text}" letter-spacing="6">记忆大脑</text>`,
  );
  lines.push(
    `  <text x="${SVG.cx}" y="82" text-anchor="middle" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" font-size="14" fill="${SVG.colors.muted}">QQ Bridge 记忆系统 · 保护线 ${percent(
      model.protectionLine,
    )} · 生成于 ${escapeXml(formatUtc(model.now))}</text>`,
  );
  lines.push(
    `  <text x="${SVG.cx}" y="104" text-anchor="middle" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" font-size="12" fill="${SVG.colors.faint}">同心记忆环：越靠近中心越重要，越靠外越接近淡忘</text>`,
  );

  // ---- 记忆环（浅色带 + 虚线参考圆） ----
  lines.push('  <g id="memory-rings">');
  LAYER_ORDER.forEach((layerKey) => {
    const band = SVG.bands[layerKey];
    const meta = LAYER_META[layerKey];
    const middle = (band.inner + band.outer) / 2;
    const width = band.outer - band.inner;
    const bandOpacity = layerKey === 'permanent' ? 0.16 : layerKey === 'edge' ? 0.12 : 0.1;
    lines.push(
      `    <circle cx="${SVG.cx}" cy="${SVG.cy}" r="${num(middle)}" fill="none" stroke="${meta.svgColor}" stroke-opacity="${bandOpacity}" stroke-width="${num(
        width,
      )}"/>`,
    );
    lines.push(
      `    <circle cx="${SVG.cx}" cy="${SVG.cy}" r="${num(middle)}" fill="none" stroke="${meta.svgColor}" stroke-opacity="0.22" stroke-width="1" stroke-dasharray="4 8"/>`,
    );
  });
  // 同步记忆环（大脑外第一圈，虚线 + 旋转箭头）
  lines.push(
    `    <circle cx="${SVG.cx}" cy="${SVG.cy}" r="${SVG.syncRadius}" fill="none" stroke="#CBD5E1" stroke-width="1.6" stroke-dasharray="6 8"/>`,
  );
  for (const angle of [-90, 90]) {
    const rad = (angle * Math.PI) / 180;
    const x = SVG.cx + SVG.syncRadius * Math.cos(rad);
    const y = SVG.cy + SVG.syncRadius * Math.sin(rad);
    lines.push(
      `    <polygon points="${num(x)},${num(y - 7)} ${num(x + 7)},${num(y)} ${num(x)},${num(
        y + 7,
      )}" fill="${SVG.colors.faint}" opacity="0.8" transform="rotate(${angle > 0 ? 90 : -90} ${num(x)} ${num(y)})"/>`,
    );
  }
  lines.push('  </g>');

  // ---- 记忆环标签（顶部，避开 12 点方向的箭头） ----
  lines.push('  <g id="ring-labels">');
  LAYER_ORDER.forEach((layerKey, layerIndex) => {
    const band = SVG.bands[layerKey];
    const meta = LAYER_META[layerKey];
    const middle = (band.inner + band.outer) / 2;
    const angle = (-90 - 14 - layerIndex * 5) * (Math.PI / 180);
    const x = SVG.cx + middle * Math.cos(angle);
    const y = SVG.cy + middle * Math.sin(angle) + 4;
    lines.push(
      `    <text x="${num(x)}" y="${num(y)}" text-anchor="middle" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" font-size="10" letter-spacing="2" fill="${meta.svgColor}" fill-opacity="0.7" stroke="${SVG.colors.background}" stroke-width="3" paint-order="stroke">${meta.shortLabel}环</text>`,
    );
  });
  lines.push('  </g>');

  // ---- 实体 ↔ 实体关系线 ----
  lines.push('  <g id="entity-relations">');
  let relationLabelCount = 0;
  for (const relation of model.relations) {
    const a = entityPositions.get(relation.from);
    const b = entityPositions.get(relation.to);
    if (!a || !b) continue;
    lines.push(
      `    <line x1="${num(a.x)}" y1="${num(a.y)}" x2="${num(b.x)}" y2="${num(b.y)}" stroke="${SVG.colors.faint}" stroke-opacity="0.32" stroke-width="1.1"/>`,
    );
    if (model.relations.length <= 16 && relationLabelCount < 16) {
      relationLabelCount += 1;
      lines.push(
        `    <text x="${num((a.x + b.x) / 2)}" y="${num((a.y + b.y) / 2 - 3)}" text-anchor="middle" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" font-size="9" fill="${SVG.colors.muted}" stroke="${SVG.colors.background}" stroke-width="3" paint-order="stroke">${escapeXml(
          relationLabelOf(relation.relation),
        )}</text>`,
      );
    }
  }
  lines.push('  </g>');

  // ---- 记忆 ↔ 实体细连线 ----
  lines.push('  <g id="memory-entity-links">');
  let memoryEntityLinks = 0;
  const allMemoryPositions = LAYER_ORDER.flatMap((layerKey) => bandPositions[layerKey]);
  for (const position of allMemoryPositions) {
    if (memoryEntityLinks >= SVG_MAX_MEMORY_ENTITY_LINKS) break;
    let linked = 0;
    for (const entity of position.memory.entities) {
      const entityPosition = entityPositions.get(entity.id);
      if (!entityPosition) continue;
      lines.push(
        `    <line x1="${num(position.x)}" y1="${num(position.y)}" x2="${num(entityPosition.x)}" y2="${num(
          entityPosition.y,
        )}" stroke="${LAYER_META[position.memory.vaultLayer].svgColor}" stroke-opacity="0.14" stroke-width="0.8"/>`,
      );
      linked += 1;
      memoryEntityLinks += 1;
      if (linked >= 2 || memoryEntityLinks >= SVG_MAX_MEMORY_ENTITY_LINKS) break;
    }
  }
  lines.push('  </g>');

  // ---- v1.3 共激活突触（记忆之间，紫色细线） ----
  lines.push('  <g id="memory-synapses">');
  let synapseLinks = 0;
  for (const synapse of model.synapses || []) {
    if (synapseLinks >= 160) break;
    const from = allMemoryPositions.find((position) => position.memory.id === synapse.from);
    const to = allMemoryPositions.find((position) => position.memory.id === synapse.to);
    if (!from || !to) continue;
    lines.push(
      `    <line x1="${num(from.x)}" y1="${num(from.y)}" x2="${num(to.x)}" y2="${num(to.y)}" stroke="#8B5CF6" stroke-opacity="0.22" stroke-width="1" stroke-dasharray="2 4"/>`,
    );
    synapseLinks += 1;
  }
  lines.push('  </g>');

  // ---- 记忆点 ----
  lines.push('  <g id="memory-nodes">');
  for (const layerKey of LAYER_ORDER) {
    const meta = LAYER_META[layerKey];
    for (const position of bandPositions[layerKey]) {
      const { memory } = position;
      let radius;
      let opacity;
      if (layerKey === 'permanent') {
        radius = 7 + memory.strength * 4;
        opacity = 1;
      } else if (layerKey === 'long') {
        radius = 3.5 + memory.strength * 4.5;
        opacity = 0.55 + memory.strength * 0.45;
      } else if (layerKey === 'short') {
        radius = 3 + memory.strength * 3.5;
        opacity = 0.45 + memory.strength * 0.45;
      } else {
        radius = 2 + memory.strength * 4;
        opacity = Math.min(0.6, 0.22 + memory.strength * 1.4);
      }
      const glow = layerKey === 'permanent' ? ' filter="url(#goldGlow)"' : '';
      lines.push(
        `    <circle cx="${num(position.x)}" cy="${num(position.y)}" r="${num(radius)}" fill="${meta.svgColor}" fill-opacity="${num(
          opacity,
        )}" stroke="#FFFFFF" stroke-width="1.2" stroke-opacity="${layerKey === 'edge' ? '0.35' : '0.8'}"${glow}><title>${escapeXml(
          `${memory.title} · ${meta.shortLabel} · 强度 ${percent(memory.strength)} · ${memory.status}`,
        )}</title></circle>`,
      );
      if (layerKey === 'permanent') {
        const labelX = position.x + Math.cos(position.angle) * 20;
        const labelY = position.y + Math.sin(position.angle) * 20 + 4;
        const cos = Math.cos(position.angle);
        const anchor = cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle';
        const clampedX = clampSvgLabelX(labelX, anchor, SVG.width);
        lines.push(
          `    <text x="${num(clampedX)}" y="${num(labelY)}" text-anchor="${anchor}" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" font-size="12" font-weight="600" fill="#A97C00" stroke="${SVG.colors.background}" stroke-width="3" paint-order="stroke">${escapeXml(
            truncateLabel(memory.title, 14),
          )}</text>`,
        );
      } else if (layerKey === 'edge' && position.memory.strength < 0.3) {
        // 边缘残片：只剩一个字 + 暗点。
        lines.push(
          `    <text x="${num(position.x)}" y="${num(position.y + 3.5)}" text-anchor="middle" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" font-size="9" fill="#374151" fill-opacity="${num(
            Math.min(0.6, 0.3 + memory.strength),
          )}">${escapeXml(memory.firstChar)}</text>`,
        );
      }
    }
  }
  lines.push('  </g>');

  // ---- 实体节点 ----
  lines.push('  <g id="entity-nodes">');
  for (const entityPosition of entityPositions.values()) {
    const { entity, angle } = entityPosition;
    const color = ENTITY_TYPE_META[entity.type].color;
    const labelX = entityPosition.x + Math.cos(angle) * 22;
    const labelY = entityPosition.y + Math.sin(angle) * 22 + 4;
    const cos = Math.cos(angle);
    const anchor = cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle';
    const clampedX = clampSvgLabelX(labelX, anchor, SVG.width);
    lines.push(
      `    <circle cx="${num(entityPosition.x)}" cy="${num(entityPosition.y)}" r="11" fill="${color}" fill-opacity="0.9" stroke="#FFFFFF" stroke-width="2.5"><title>${escapeXml(
        `${entity.name} · ${ENTITY_TYPE_META[entity.type].label} · 提及 ${entity.mentionCount} 次`,
      )}</title></circle>`,
    );
    lines.push(
      `    <text x="${num(clampedX)}" y="${num(labelY)}" text-anchor="${anchor}" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" font-size="11" fill="#334155" stroke="${SVG.colors.background}" stroke-width="3" paint-order="stroke">${escapeXml(
        truncateLabel(entity.name, 12),
      )}</text>`,
    );
  }
  lines.push('  </g>');

  // ---- 中心大脑 ----
  lines.push('  <g id="center-brain">');
  lines.push(
    `    <circle cx="${SVG.cx}" cy="${SVG.cy}" r="150" fill="url(#centerGlow)"/>`,
  );
  lines.push(
    `    <circle cx="${SVG.cx}" cy="${SVG.cy}" r="${SVG.brainRadius}" fill="#FFFFFF" stroke="${SVG.colors.brainStroke}" stroke-width="2" filter="url(#brainShadow)"/>`,
  );
  // 大脑轮廓 + 回旋线（固定坐标，无随机）
  const brainPath = [
    'M 0,-46',
    'C 14,-56 34,-50 40,-34',
    'C 58,-30 62,-8 48,4',
    'C 50,20 38,34 22,36',
    'C 14,48 -2,50 -12,42',
    'C -28,46 -42,36 -44,22',
    'C -58,14 -60,-6 -48,-18',
    'C -50,-34 -34,-46 -18,-44',
    'C -10,-50 -4,-49 0,-46',
    'Z',
  ].join(' ');
  lines.push(
    `    <path d="${brainPath}" transform="translate(${SVG.cx} ${SVG.cy - 6})" fill="${SVG.colors.brainFill}" stroke="${SVG.colors.brainStroke}" stroke-width="2" stroke-linejoin="round"/>`,
  );
  const gyri = [
    'M -34,-24 C -24,-30 -14,-24 -8,-14',
    'M -2,-34 C 8,-38 20,-30 24,-18',
    'M -38,-2 C -28,-6 -20,0 -16,10',
    'M -4,18 C 6,12 16,16 20,26',
    'M 26,4 C 34,0 40,6 42,14',
    'M 14,-6 C 20,-2 20,6 16,12',
    'M -22,28 C -14,24 -6,28 -2,34',
    'M 0,-40 C 3,-22 -3,-10 0,4 C 2,16 -1,28 -4,38',
  ];
  for (const d of gyri) {
    lines.push(
      `    <path d="${d}" transform="translate(${SVG.cx} ${SVG.cy - 6})" fill="none" stroke="${SVG.colors.brainLine}" stroke-width="1.6" stroke-linecap="round" opacity="0.85"/>`,
    );
  }
  lines.push(
    `    <text x="${SVG.cx}" y="${SVG.cy + 66}" text-anchor="middle" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" font-size="15" font-weight="700" fill="${SVG.colors.text}">记忆大脑</text>`,
  );
  lines.push('  </g>');

  // ---- 图例（底部横条） ----
  const stats = model.stats;
  lines.push('  <g id="legend">');
  lines.push(
    `    <rect x="392" y="944" width="816" height="40" rx="10" fill="#FFFFFF" fill-opacity="0.86" stroke="${SVG.colors.guide}" stroke-width="1"/>`,
  );
  lines.push(
    `    <text x="410" y="969" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" font-size="12" font-weight="700" fill="${SVG.colors.text}">图例</text>`,
  );
  const legendItems = [
    { x: 470, color: LAYER_META.permanent.svgColor, radius: 8, text: '永久记忆（金色发光）' },
    { x: 632, color: LAYER_META.long.svgColor, radius: 6, text: '长期记忆' },
    { x: 758, color: LAYER_META.short.svgColor, radius: 5, text: '短期记忆' },
    { x: 880, color: LAYER_META.edge.svgColor, radius: 4, text: '边缘残片' },
    { x: 1004, color: ENTITY_TYPE_META.person.color, radius: 8, entity: true, text: '实体节点' },
  ];
  for (const item of legendItems) {
    lines.push(
      `    <circle cx="${item.x}" cy="964" r="${item.radius}" fill="${item.color}" ${
        item.entity ? 'fill-opacity="0.9" stroke="#FFFFFF" stroke-width="2"' : ''
      }/>`,
    );
    lines.push(
      `    <text x="${item.x + 16}" y="969" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" font-size="12" fill="${SVG.colors.muted}">${escapeXml(
        item.text,
      )}</text>`,
    );
  }
  lines.push('  </g>');

  // ---- 概览面板（右上） ----
  lines.push('  <g id="overview">');
  lines.push(
    `    <rect x="1128" y="118" width="424" height="238" rx="12" fill="#FFFFFF" fill-opacity="0.9" stroke="${SVG.colors.guide}" stroke-width="1"/>`,
  );
  lines.push(
    `    <text x="1152" y="148" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" font-size="16" font-weight="700" fill="${SVG.colors.text}">记忆大脑 · 概览</text>`,
  );
  const overviewRows = [
    `记忆总数：${stats.total} 条`,
    `同步记忆环：${stats.total} 条记忆在线`,
    `永久环：${stats.vaultLayers.permanent} 条（金色发光）`,
    `长期环：${stats.vaultLayers.long} 条（${stats.decayDays.long} 天衰减）`,
    `短期环：${stats.vaultLayers.short} 条（${stats.decayDays.short} 天衰减）`,
    `边缘环：${stats.vaultLayers.edge} 条（即将淡忘）`,
    `实体：${stats.entities} 个 · 关系：${stats.relations} 条`,
    `保护线：${percent(stats.protectionLine)}（低于此强度会漂向边缘）`,
    `当前展示：${LAYER_ORDER.reduce((acc, key) => acc + selected[key].length, 0)}/${model.memories.length} 条记忆 · ${entities.length}/${model.entities.length} 个实体`,
  ];
  overviewRows.forEach((row, index) => {
    lines.push(
      `    <text x="1152" y="${num(174 + index * 21)}" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" font-size="12" fill="${SVG.colors.muted}">${escapeXml(
        row,
      )}</text>`,
    );
  });
  lines.push('  </g>');

  // ---- 页脚 ----
  lines.push(
    `  <text x="${SVG.cx}" y="992" text-anchor="middle" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" font-size="10" fill="${SVG.colors.faint}">由 QQ Bridge 记忆系统自动生成，手改会被覆盖 · vault v${VAULT_VERSION}</text>`,
  );
  lines.push('</svg>');
  lines.push('');

  return {
    svg: lines.join('\n'),
    displayed: {
      memories: LAYER_ORDER.reduce((acc, layerKey) => acc + selected[layerKey].length, 0),
      entities: entities.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Obsidian 配置
// ---------------------------------------------------------------------------

function buildObsidianAppJson() {
  return `${JSON.stringify(
    {
      alwaysUpdateLinks: true,
      newFileLocation: 'folder',
      newFileFolderPath: '记忆/短期',
      attachmentFolderPath: '附件',
      useMarkdownLinks: false,
      showLineNumber: true,
      readableLineLength: true,
      defaultViewMode: 'preview',
    },
    null,
    2,
  )}\n`;
}

function buildObsidianGraphJson() {
  return `${JSON.stringify(
    {
      'collapse-filter': false,
      search: '',
      showTags: false,
      showAttachments: false,
      hideUnresolved: false,
      showOrphans: true,
      'collapse-color-groups': false,
      colorGroups: GRAPH_COLOR_GROUPS.map((group) => ({
        query: group.query,
        color: { a: 1, rgb: group.rgb },
      })),
      'collapse-display': true,
      showArrow: false,
      textFadeMultiplier: 0,
      nodeSizeMultiplier: 1.1,
      lineSizeMultiplier: 1,
      'collapse-forces': true,
      centerStrength: 0.52,
      repelStrength: 10,
      linkStrength: 1,
      linkDistance: 250,
      scale: 1,
      close: false,
    },
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------------------
// 写盘 / 清理
// ---------------------------------------------------------------------------

function walkMarkdownFiles(rootDir, relativePrefix) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return out;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(rootDir, entry.name);
    const relative = `${relativePrefix}/${entry.name}`;
    if (entry.isSymbolicLink()) continue; // 不跟随符号链接，避免删到 vault 外
    if (entry.isDirectory()) {
      out.push(...walkMarkdownFiles(absolute, relative));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push({ absolute, relative });
    }
  }
  return out;
}

/** 只清理 vaultDir 下 `记忆/`、`实体/`、`日记/` 里不在本次生成清单中的旧 .md。 */
function cleanupStaleFiles(vaultDir, plannedPaths) {
  let cleaned = 0;
  for (const base of ['记忆', '实体', '日记']) {
    const baseDir = path.join(vaultDir, base);
    for (const file of walkMarkdownFiles(baseDir, base)) {
      if (plannedPaths.has(file.relative)) continue;
      try {
        fs.unlinkSync(file.absolute);
        cleaned += 1;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  return cleaned;
}

/** 收集本次要写的全部文件内容（纯内存计算，写盘前就绪）。 */
function buildVaultFiles(model) {
  const files = new Map();
  files.set('README.md', buildReadme(model));
  files.set('00-记忆大脑.md', buildHomePage(model));
  for (const memory of model.memories) {
    files.set(memory.relPath, buildMemoryNote(model, memory));
  }
  for (const entity of model.entities) {
    files.set(entity.relPath, buildEntityNote(model, entity));
  }
  const canvas = buildCanvas(model);
  files.set('图谱/记忆大脑.canvas', canvas.json);
  const svg = buildSvg(model);
  files.set('图谱/记忆大脑.svg', svg.svg);
  const topology = buildTopologyFiles(model);
  for (const [relativePath, content] of topology) files.set(relativePath, content);
  files.set('.obsidian/app.json', buildObsidianAppJson());
  files.set('.obsidian/graph.json', buildObsidianGraphJson());
  return { files, canvas: canvas.stats, svg: { bytes: Buffer.byteLength(svg.svg, 'utf8') } };
}

/**
 * 把 brain 渲染成 Obsidian vault（原子性：先算好全部内容，再清理旧文件、逐文件写入）。
 *
 * @param {object} brain docs/guides/MEMORY_SYSTEM.md §3 定义的 brain 内容
 * @param {{vaultDir: string, now?: number}} options
 * @returns {{files: string[], stats: object}} files 是相对 vaultDir 的 POSIX 路径
 */
export function renderVault(brain, options = {}) {
  if (!options || typeof options !== 'object') throw new TypeError('renderVault: options 必须是对象');
  const vaultDirRaw = options.vaultDir;
  if (typeof vaultDirRaw !== 'string' || vaultDirRaw.trim() === '') {
    throw new TypeError('renderVault: 需要 vaultDir（vault 输出目录）');
  }
  const vaultDir = path.resolve(vaultDirRaw.trim());
  if (path.parse(vaultDir).root === vaultDir) {
    throw new Error(`renderVault: 拒绝把文件系统根目录当作 vault：${vaultDir}`);
  }
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const model = buildVaultModel(brain, { now });
  const { files, canvas, svg } = buildVaultFiles(model);

  fs.mkdirSync(vaultDir, { recursive: true });
  const cleaned = cleanupStaleFiles(vaultDir, new Set(files.keys()));

  let written = 0;
  for (const [relativePath, content] of files) {
    const absolutePath = path.join(vaultDir, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf8');
    written += 1;
  }

  const stats = {
    ...model.stats,
    version: VAULT_VERSION,
    generatedAt: now,
    vaultDir,
    filesWritten: written,
    cleaned,
    canvas,
    svg,
    displayLimit: { canvas: CANVAS_CAPS, svg: SVG_CAPS },
  };
  return { files: [...files.keys()], stats };
}
