#!/usr/bin/env node
// 全量知识图谱种子导入器（bootstrap）：读取真实 state 数据 → 生成 state/memory/seed.json。
//
// 契约来源：docs/guides/MEMORY_SYSTEM.md
//   §3  brain 数据模型（实体/关系/记忆字段）
//   §7  seed.json 格式（{version, generatedAt, sources, entities[], relations[], memories[]}）
//   §11 验收（seed schema、幂等、脱敏）
//
// 数据来源（全部只读，绝不修改 state 下其它文件）：
//   state/social-v2.json  群/私聊会话 → group/person 实体、memberImpressions → 人物实体 note、
//                          activeTopics → topic 实体 + long 记忆、lastTurnSummary → long 记忆
//   state/sessions.json   sessionPolicies / sessionVariants → 会话实体 tags/note（无可靠图目标，不硬造实体）
//   state/slang.json      confirmed（或带含义的 candidate）词条 → term 实体；evidence → 会话/人物 related 关系
//   state/current-role.json 当前角色名 → self 实体；config.json 的 ownerQQ → owner 判定
//   可选 --include-sessions：DSH session 归档（zstd 多帧）→ 助手回复 long 记忆（默认关闭，不阻塞交付）
//
// 设计约束：
//   - 无新增依赖（只用 node: 内置模块）；ESM；node >= 22.13（zstd 解压用 node:zlib）
//   - 幂等：相同输入 + 相同 --now → 字节级相同输出；同 source.key + 归一化 text 的记忆只留一条；
//     实体按 (type, normalizeName) 合并，关系按 (from, relation, to) 去重
//   - 过滤：空串/纯表情/纯标点/占位符（如 [图片]）、敏感串（token/密码/私钥/绝对路径/URL 等）
//   - 截断：记忆 text ≤ 2000、实体 note ≤ 500、title ≤ 60、实体名 ≤ 48
//   - 只写 --out（默认 state/memory/seed.json），原子写；内容未变化时不重写
//
// 用法：
//   node scripts/memory-bootstrap.mjs [--state <dir>] [--out <file>] [--now <epochMs>]
//        [--strict-slang] [--owner-qq <qq>] [--include-sessions] [--sessions-dir <dir>]
//        [--dry-run] [--json] [--help]
//
// 产物可被 `node src/memory/cli.mjs seed state/memory/seed.json` 按序导入（幂等）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

import {
  MEMORY_CATEGORIES,
  MEMORY_LAYERS,
  ENTITY_TYPES,
  LEGACY_RELATION_ALIASES,
  RELATION_LEGACY_TYPES,
  RELATION_TYPES,
  extractKeywords,
  normalizeName,
  normalizeText,
} from '../src/memory/model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const SEED_VERSION = 1;

export const LIMITS = Object.freeze({
  entityName: 48,
  entityNote: 500,
  alias: 32,
  aliasesPerEntity: 6,
  tagsPerEntity: 8,
  tag: 24,
  memoryText: 2000,
  title: 60,
  keyword: 24,
  keywordsPerMemory: 8,
  entityNamesPerMemory: 8,
  sessionArchiveText: 1200,
  sessionArchivePerConversation: 40,
  sessionArchiveMaxBytes: 8 * 1024 * 1024,
});

const ENTITY_TYPE_ORDER = ['self', 'person', 'group', 'topic', 'term', 'event', 'project'];
const VALID_ENTITY_TYPES = new Set(ENTITY_TYPES);
// v1.4：seed 里允许写旧式关系名（member_of/owner_of/...），入 brain 时由 normalizeRelationType 归一。
const VALID_RELATION_TYPES = new Set([
  ...RELATION_TYPES,
  ...RELATION_LEGACY_TYPES,
  ...Object.keys(LEGACY_RELATION_ALIASES),
]);
const VALID_MEMORY_LAYERS = new Set(MEMORY_LAYERS);
const VALID_MEMORY_CATEGORIES = new Set(MEMORY_CATEGORIES);

// ---------------------------------------------------------------------------
// 敏感串过滤（§11 脱敏）
// ---------------------------------------------------------------------------

const RAW_SENSITIVE_PATTERNS = [
  {
    name: 'private-key',
    source: '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----',
    flags: 'gi',
    replacement: '[密钥]',
  },
  {
    name: 'api-key',
    source: '\\b(?:sk|pk|rk|ghp|gho|ghs|ghu|xox[abprs])[-_][A-Za-z0-9_-]{8,}\\b',
    flags: 'g',
    replacement: '[密钥]',
  },
  {
    name: 'bearer-token',
    source: '\\bBearer\\s+[A-Za-z0-9._~+/=-]{8,}',
    flags: 'gi',
    replacement: '[令牌]',
  },
  {
    name: 'long-hex',
    source: '\\b[A-Fa-f0-9]{40,}\\b',
    flags: 'g',
    replacement: '[令牌]',
  },
  {
    name: 'long-opaque-token',
    source: '\\b(?=[A-Za-z0-9_-]*\\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\\b',
    flags: 'g',
    replacement: '[令牌]',
  },
  {
    name: 'url',
    source: 'https?:\\/\\/[^\\s"\'<>）)】\\]]+',
    flags: 'g',
    replacement: '[链接]',
  },
  {
    name: 'kv-secret',
    source:
      '(?<![\\w])(?:password|passwd|pwd|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|token)\\s*[:=：]\\s*["\']?[^\\s"\',，。；、)]{4,}',
    flags: 'gi',
    replacement: '[已脱敏]',
  },
  {
    name: 'cn-secret',
    source: '(?:密码|口令|密钥|令牌|凭证)\\s*(?:是|为|[:：=])\\s*[^\\s，。；、)]{2,}',
    flags: 'g',
    replacement: '[已脱敏]',
  },
  {
    name: 'windows-path',
    source: '[A-Za-z]:\\\\(?:[^\\s\\\\"\'<>|:*?]+\\\\)*[^\\s\\\\"\'<>|:*?]*',
    flags: 'g',
    replacement: '[路径]',
  },
  {
    name: 'windows-forward-path',
    source: '[A-Za-z]:/(?:[^\\s"\'<>|:*?]+/)*[^\\s"\'<>|:*?]*',
    flags: 'g',
    replacement: '[路径]',
  },
  {
    name: 'unc-path',
    source: '\\\\\\\\[A-Za-z0-9.$_-]+\\\\[^\\s"\'<>|]+',
    flags: 'g',
    replacement: '[路径]',
  },
  {
    name: 'unix-home-path',
    source: '(?:/home/|/Users/|/root/)[^\\s"\'<>|）)]+',
    flags: 'g',
    replacement: '[路径]',
  },
];

const SENSITIVE_PATTERNS = RAW_SENSITIVE_PATTERNS.map((pattern) => ({
  ...pattern,
  regex: new RegExp(pattern.source, pattern.flags),
  testRegex: new RegExp(pattern.source, pattern.flags.replace(/g/g, '')),
}));

/** 文本里是否含明显敏感串（token / 密码 / 绝对路径 …）。 */
export function containsSensitive(value) {
  const text = String(value ?? '');
  if (!text) return false;
  return SENSITIVE_PATTERNS.some((pattern) => {
    pattern.testRegex.lastIndex = 0;
    return pattern.testRegex.test(text);
  });
}

/** 把敏感串替换成占位符，返回 {text, hits, names}。 */
export function redactSensitive(value) {
  let text = String(value ?? '');
  const names = [];
  for (const pattern of SENSITIVE_PATTERNS) {
    const before = text;
    text = text.replace(pattern.regex, pattern.replacement);
    if (text !== before) names.push(pattern.name);
  }
  return { text, hits: names.length, names };
}

// ---------------------------------------------------------------------------
// 文本工具（归一化复用 model.mjs，保证与服务侧 ID/去重一致）
// ---------------------------------------------------------------------------

export function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 截断到 max 个字符（含省略号），保持 ≤ max。 */
export function truncateText(value, max) {
  const text = normalizeText(value);
  if (!Number.isFinite(max) || max <= 0) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

const PLACEHOLDER_ONLY = /^(?:\[[^\]]{0,12}\]\s*)+$/u;

/** 去掉 emoji / 标点 / 空白等「非文字」字符（保留数字，但 keycap 表情如 1️⃣ 整体剔除）。 */
function stripNonText(value) {
  return String(value ?? '')
    .replace(/[#0-9*]\uFE0F?\u20E3/gu, '') // keycap 表情：1️⃣、#️⃣、*️⃣
    .replace(/[\p{P}\p{S}\p{Z}\s\u200d\ufe0f]/gu, '');
}

/** 空串 / 纯表情 / 纯标点 / 纯占位符（[图片]、[表情] …）视为无意义文本。 */
export function isMeaningfulText(value) {
  const text = normalizeText(value);
  if (!text) return false;
  if (PLACEHOLDER_ONLY.test(text)) return false;
  return stripNonText(text).length > 0;
}

/** 取第一句作为标题/短名（尽量在中文句读处断开，再截断）。 */
export function shortTitle(value, max = LIMITS.title) {
  const text = normalizeText(value);
  if (!text) return '';
  const sentence = text.split(/(?<=[。！？!?；;])/u)[0] || text;
  return truncateText(sentence, max);
}

function looksLikeEmojiOnly(value) {
  const text = normalizeText(value);
  if (!text) return true;
  return stripNonText(text).length === 0;
}

function cleanStringList(list, { limit, maxLen, exclude = [], trimSensitive = true }) {
  const out = [];
  const seen = new Set();
  const excluded = new Set(exclude.map((item) => normalizeName(item)));
  for (const raw of Array.isArray(list) ? list : []) {
    let value = truncateText(raw, maxLen);
    if (!value || !isMeaningfulText(value)) continue;
    if (trimSensitive && containsSensitive(value)) {
      value = redactSensitive(value).text;
      if (!isMeaningfulText(value) || containsSensitive(value)) continue;
    }
    const key = normalizeName(value);
    if (!key || seen.has(key) || excluded.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function clamp01(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

// ---------------------------------------------------------------------------
// zstd 多帧读取（node:zlib 的 zstdDecompressSync 只解第一帧；DSH 归档是多帧拼接）
// ---------------------------------------------------------------------------

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_MAGIC_BUFFER = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function readZstdFrameEnd(buffer, start) {
  let offset = start;
  if (offset + 4 > buffer.length || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
    throw new Error(`非法 zstd 帧（magic 不匹配 @${start}）`);
  }
  offset += 4;
  if (offset >= buffer.length) throw new Error(`zstd 帧头截断 @${start}`);
  const frameHeader = buffer[offset];
  offset += 1;
  const fcsFlag = frameHeader >> 6;
  const singleSegment = (frameHeader >> 5) & 1;
  const hasChecksum = (frameHeader >> 2) & 1;
  const dictFlag = frameHeader & 3;
  if (!singleSegment) offset += 1; // window descriptor
  offset += [0, 1, 2, 4][dictFlag]; // dictionary id
  // FCS 字段：flag 0 → singleSegment ? 1 : 0；flag 1 → 2；flag 2 → 4；flag 3 → 8
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  offset += fcsSize;
  while (true) {
    if (offset + 3 > buffer.length) throw new Error(`zstd block header 截断 @${offset}`);
    const header = buffer.readUIntLE(offset, 3);
    offset += 3;
    const last = header & 1;
    const type = (header >> 1) & 3;
    const blockSize = header >> 3;
    if (type === 3) throw new Error(`zstd block 类型非法 @${offset}`);
    offset += type === 1 ? 1 : blockSize; // RLE block 只有 1 字节
    if (offset > buffer.length) throw new Error(`zstd block 数据截断 @${offset}`);
    if (last === 1) break;
  }
  if (hasChecksum) offset += 4;
  return offset;
}

/** 把 zstd 归档（可能多帧拼接）拆成帧 buffer 数组。 */
export function splitZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error(`zstd 尾部垃圾数据 @${offset}`);
    const magic = buffer.readUInt32LE(offset);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      // skippable frame：4 字节 magic + 4 字节长度 + 载荷
      if (offset + 8 > buffer.length) throw new Error(`zstd skippable 帧截断 @${offset}`);
      const size = buffer.readUInt32LE(offset + 4);
      offset += 8 + size;
      if (offset > buffer.length) throw new Error(`zstd skippable 载荷截断 @${offset}`);
      continue;
    }
    if (magic !== ZSTD_MAGIC) throw new Error(`非法 zstd magic @${offset}`);
    const end = readZstdFrameEnd(buffer, offset);
    frames.push(buffer.subarray(offset, end));
    offset = end;
  }
  return frames;
}

/** 解码 zstd 归档（多帧）→ Buffer。 */
export function decompressZstdArchive(buffer) {
  if (!buffer || buffer.length === 0) return Buffer.alloc(0);
  try {
    const frames = splitZstdFrames(buffer);
    if (!frames.length) throw new Error('没有解析到 zstd 帧');
    return Buffer.concat(frames.map((frame) => zstdDecompressSync(frame)));
  } catch (error) {
    // 兜底：按 zstd magic 扫描切帧（极少数自定义帧头/版本差异时仍可用）
    return decompressZstdByMagicScan(buffer, error);
  }
}

function decompressZstdByMagicScan(buffer, firstError) {
  const starts = [];
  let index = buffer.indexOf(ZSTD_MAGIC_BUFFER, 0);
  while (index !== -1) {
    starts.push(index);
    index = buffer.indexOf(ZSTD_MAGIC_BUFFER, index + 1);
  }
  if (!starts.length) throw firstError;
  const chunks = [];
  let frameIndex = 0;
  while (frameIndex < starts.length) {
    const start = starts[frameIndex];
    let next = frameIndex + 1;
    let decoded = null;
    while (next <= starts.length) {
      const end = next < starts.length ? starts[next] : buffer.length;
      try {
        decoded = zstdDecompressSync(buffer.subarray(start, end));
        break;
      } catch {
        next += 1;
      }
    }
    if (decoded === null) throw firstError;
    chunks.push(decoded);
    frameIndex = next;
  }
  return Buffer.concat(chunks);
}

/** 解析 JSONL 文本 → {records, badLines}。 */
export function parseJsonl(text) {
  const records = [];
  let badLines = 0;
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      badLines += 1;
    }
  }
  return { records, badLines };
}

/** 从 DSH session JSONL 记录里提取助手回复文本（跳过 reasoning / tool-call / 工具结果）。 */
export function extractAssistantTexts(records) {
  const out = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || record.type !== 'assistant/message') continue;
    const content = record?.message?.content ?? record?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'text') continue;
      const text = normalizeText(block.text);
      if (text) out.push(text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 文件读取 / 参数解析
// ---------------------------------------------------------------------------

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function labelPath(filePath, root = REPO_ROOT) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(root, absolute);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return `${path.basename(path.dirname(absolute))}/${path.basename(absolute)}`;
}

function readJson(filePath, warnings) {
  if (!fs.existsSync(filePath)) {
    warnings.push(`缺少数据源：${filePath}`);
    return null;
  }
  try {
    return JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    warnings.push(`解析失败 ${filePath}：${error.message}`);
    return null;
  }
}

export function parseArgs(argv) {
  const opts = {
    state: null,
    out: null,
    now: null,
    strictSlang: false,
    ownerQQ: null,
    includeSessions: false,
    sessionsDir: null,
    dryRun: false,
    json: false,
    help: false,
  };
  const takesValue = new Set(['--state', '--out', '--now', '--owner-qq', '--sessions-dir']);
  const flags = new Set([
    '--strict-slang',
    '--include-sessions',
    '--dry-run',
    '--json',
    '--help',
    '-h',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (takesValue.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`参数 ${arg} 缺少取值`);
      index += 1;
      if (arg === '--state') opts.state = value;
      else if (arg === '--out') opts.out = value;
      else if (arg === '--now') {
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0) throw new Error(`--now 需要正整数毫秒时间戳：${value}`);
        opts.now = Math.trunc(number);
      } else if (arg === '--owner-qq') opts.ownerQQ = String(value).trim();
      else if (arg === '--sessions-dir') opts.sessionsDir = value;
      continue;
    }
    if (!flags.has(arg)) throw new Error(`未知参数：${arg}`);
    if (arg === '--strict-slang') opts.strictSlang = true;
    else if (arg === '--include-sessions') opts.includeSessions = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else opts.help = true;
  }
  return opts;
}

function usage() {
  return [
    '用法: node scripts/memory-bootstrap.mjs [选项]',
    '',
    '  --state <dir>          状态目录（默认 <repo>/state）',
    '  --out <file>           输出文件（默认 <state>/memory/seed.json）',
    '  --now <epochMs>        generatedAt 固定值（测试/幂等复现用）',
    '  --strict-slang         只收 status=confirmed 的黑话词条（默认收 confirmed + 带含义的 candidate）',
    '  --owner-qq <qq>        覆盖 config.json 的 ownerQQ（测试用）',
    '  --include-sessions     可选：读 DSH session 归档（zstd）补充助手回复的长期记忆',
    '  --sessions-dir <dir>   DSH session 归档根目录（默认 ~/.dsh/sessions）',
    '  --dry-run              只统计不写文件',
    '  --json                 以 JSON 打印统计（仍会写文件，除非 --dry-run）',
    '  --help, -h             显示帮助',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 图构建：实体 / 关系 / 记忆收集器
// ---------------------------------------------------------------------------

function createContext({ now, strictSlang, sources, warnings, ownerQQ }) {
  return {
    now,
    strictSlang,
    sources,
    warnings,
    ownerQQ: ownerQQ ? String(ownerQQ) : null,
    entities: new Map(),
    relations: new Map(),
    memories: new Map(),
    convEntities: new Map(), // 会话 key → 会话实体名
    convTokens: new Map(), // 会话 key → [{token, entityName}]（用于把摘要/话题里提到的人挂到记忆上）
    personTokens: new Map(), // 归一化 token → person/self 实体名
    linkTokens: [], // 全局 {token, entityName}
    selfEntityName: null,
    ownerEntityName: null,
    sessionMeta: new Map(), // 会话 key → {preset, variant}
    stats: {
      filtered: {
        emptyEntity: 0,
        sensitiveEntity: 0,
        duplicateEntity: 0,
        emptyMemory: 0,
        emptyTopic: 0,
        sensitiveMemory: 0,
        duplicateMemory: 0,
        duplicateRelation: 0,
        unresolvedRelation: 0,
        unresolvedEntityRef: 0,
        slangSkipped: 0,
        unknownConversation: 0,
        badConversation: 0,
      },
      redactions: 0,
      archives: { files: 0, frames: 0, records: 0, badLines: 0, assistantTexts: 0, memories: 0, skipped: 0 },
    },
  };
}

/** 从昵称派生「核心名」链接词（只用于把记忆挂到实体上，不写进 aliases）：
 *  - 去掉括号后缀：喵小言（颜心）→ 喵小言
 *  - 去掉「较长且不含汉字的尾巴」：木蘸糖QAQ → 木蘸糖、小蘸糖QAQ → 小蘸糖
 *  单字前缀/太泛的前缀不派生，避免把「群友A / 群友B」都连成「群友」。 */
export function deriveCoreTokens(name) {
  const text = normalizeText(name);
  if (!text) return [];
  const out = [];
  const withoutParen = text.replace(/[（(].*$/u, '').trim();
  if (withoutParen && withoutParen !== text && withoutParen.length >= 2) out.push(withoutParen);
  const base = withoutParen || text;
  const hanRun = /^\p{Script=Han}{2,}/u.exec(base);
  if (hanRun) {
    const prefix = hanRun[0];
    const rest = base.slice(prefix.length);
    if (prefix !== text && rest.length >= 2 && !/\p{Script=Han}/u.test(rest)) out.push(prefix);
  }
  return [...new Set(out)].filter(
    (token) => token !== text && token.length >= 2 && token.length <= LIMITS.alias,
  );
}

function addLinkToken(ctx, token, entityName, { person = false } = {}) {
  const clean = truncateText(token, LIMITS.alias);
  if (!clean || clean.length < 2) return;
  const key = normalizeName(clean);
  if (!key || key.length < 2) return;
  if (!ctx.linkTokens.some((item) => item.token === clean && item.entityName === entityName)) {
    ctx.linkTokens.push({ token: clean, entityName });
  }
  if (person && !ctx.personTokens.has(key)) ctx.personTokens.set(key, entityName);
}

function registerEntityTokens(ctx, entity) {
  const person = entity.type === 'person' || entity.type === 'self';
  for (const token of [entity.name, ...entity.aliases]) addLinkToken(ctx, token, entity.name, { person });
  if (person) {
    for (const token of deriveCoreTokens(entity.name)) addLinkToken(ctx, token, entity.name, { person });
  }
}

function addConvToken(ctx, convKey, entityName, extraTokens = []) {
  const list = ctx.convTokens.get(convKey) ?? [];
  const seen = new Set(list.map((item) => item.token));
  const candidates = [entityName, ...extraTokens].flatMap((token) => [token, ...deriveCoreTokens(token)]);
  for (const token of candidates) {
    const clean = truncateText(token, LIMITS.alias);
    if (!clean || clean.length < 2 || seen.has(clean)) continue;
    seen.add(clean);
    list.push({ token: clean, entityName });
  }
  ctx.convTokens.set(convKey, list);
}

function countRedactions(ctx, result) {
  if (result.hits > 0) ctx.stats.redactions += result.hits;
  return result;
}

function addEntity(ctx, spec) {
  const type = VALID_ENTITY_TYPES.has(spec?.type) ? spec.type : null;
  if (!type) return null;
  let name = normalizeText(spec.name);
  if (!name) {
    ctx.stats.filtered.emptyEntity += 1;
    return null;
  }
  name = truncateText(name, LIMITS.entityName);
  if (!isMeaningfulText(name)) {
    ctx.stats.filtered.emptyEntity += 1;
    return null;
  }
  if (containsSensitive(name)) {
    ctx.stats.filtered.sensitiveEntity += 1;
    return null;
  }
  const key = `${type}|${normalizeName(name)}`;
  const aliases = cleanStringList(spec.aliases, {
    limit: LIMITS.aliasesPerEntity,
    maxLen: LIMITS.alias,
    exclude: [name],
  });
  const tags = cleanStringList(spec.tags, { limit: LIMITS.tagsPerEntity, maxLen: LIMITS.tag });
  const rawNote = normalizeText(spec.note);
  const note = rawNote
    ? truncateText(countRedactions(ctx, redactSensitive(rawNote)).text, LIMITS.entityNote)
    : '';
  const source = normalizeSource(spec.source);

  const existing = ctx.entities.get(key);
  if (existing) {
    ctx.stats.filtered.duplicateEntity += 1;
    for (const alias of aliases) {
      if (alias === existing.name) continue;
      if (existing.aliases.some((item) => normalizeName(item) === normalizeName(alias))) continue;
      if (existing.aliases.length >= LIMITS.aliasesPerEntity) break;
      existing.aliases.push(alias);
    }
    for (const tag of tags) {
      if (!existing.tags.includes(tag) && existing.tags.length < LIMITS.tagsPerEntity) existing.tags.push(tag);
    }
    if (note && !existing.note) existing.note = note;
    else if (note && !existing.note.includes(note)) {
      existing.note = truncateText(`${existing.note}；${note}`, LIMITS.entityNote);
    }
    registerEntityTokens(ctx, existing);
    return existing;
  }

  const entity = { name, type, aliases, note, tags, source };
  ctx.entities.set(key, entity);
  registerEntityTokens(ctx, entity);
  return entity;
}

function normalizeSource(source) {
  const kind = normalizeText(source?.kind) || 'bootstrap';
  const key = normalizeText(source?.key);
  return key ? { kind, key } : { kind };
}

function addRelation(ctx, from, relation, to, note = '') {
  if (!from || !to || from === to) return null;
  if (!VALID_RELATION_TYPES.has(relation)) return null;
  const key = `${from}|${relation}|${to}`;
  if (ctx.relations.has(key)) {
    ctx.stats.filtered.duplicateRelation += 1;
    return ctx.relations.get(key);
  }
  const relationNote = truncateText(note, 200);
  const entry = { from, to, relation, note: relationNote };
  ctx.relations.set(key, entry);
  return entry;
}

function addMemory(ctx, spec) {
  let text = normalizeText(spec.text);
  if (!isMeaningfulText(text)) {
    ctx.stats.filtered.emptyMemory += 1;
    return null;
  }
  const redacted = countRedactions(ctx, redactSensitive(text));
  text = truncateText(redacted.text, LIMITS.memoryText);
  if (!isMeaningfulText(text)) {
    ctx.stats.filtered.sensitiveMemory += 1;
    return null;
  }
  const layer = VALID_MEMORY_LAYERS.has(spec.layer) ? spec.layer : 'long';
  const category = VALID_MEMORY_CATEGORIES.has(spec.category) ? spec.category : 'other';
  const sourceKey = normalizeText(spec?.source?.key);
  const dedupeKey = `${sourceKey}|${normalizeText(text)}`;
  if (ctx.memories.has(dedupeKey)) {
    ctx.stats.filtered.duplicateMemory += 1;
    return null;
  }
  const title = truncateText(spec.title || shortTitle(text, LIMITS.title), LIMITS.title) || shortTitle(text, 30);
  const keywords = cleanStringList(
    Array.isArray(spec.keywords) && spec.keywords.length ? spec.keywords : extractKeywords(text, { limit: 8 }),
    { limit: LIMITS.keywordsPerMemory, maxLen: LIMITS.keyword },
  );
  const entityNames = cleanStringList(spec.entityNames, {
    limit: LIMITS.entityNamesPerMemory,
    maxLen: LIMITS.entityName,
  });
  const tags = cleanStringList(spec.tags, { limit: 10, maxLen: LIMITS.tag });
  const memory = {
    text,
    title,
    layer,
    category,
    keywords,
    entityNames,
    tags,
    protection: clamp01(spec.protection, 0),
    source: {
      key: sourceKey,
      seqs: (Array.isArray(spec?.source?.seqs) ? spec.source.seqs : [])
        .map((seq) => Number(seq))
        .filter((seq) => Number.isFinite(seq)),
    },
  };
  ctx.memories.set(dedupeKey, memory);
  return memory;
}

function linkNamesFromText(ctx, text, baseNames, tokens) {
  const out = [];
  for (const name of Array.isArray(baseNames) ? baseNames : []) {
    const clean = normalizeText(name);
    if (clean && !out.includes(clean)) out.push(clean);
  }
  if (text) {
    for (const item of Array.isArray(tokens) ? tokens : []) {
      if (out.length >= LIMITS.entityNamesPerMemory) break;
      if (out.includes(item.entityName)) continue;
      if (item.token.length < 2) continue;
      if (text.includes(item.token)) out.push(item.entityName);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// state/social-v2.json → 实体 / 关系 / 记忆
// ---------------------------------------------------------------------------

function normalizeImpressions(rawImpressions) {
  const out = [];
  if (!rawImpressions || typeof rawImpressions !== 'object' || Array.isArray(rawImpressions)) return out;
  for (const name of Object.keys(rawImpressions).sort(compareStrings)) {
    const record = rawImpressions[name];
    const traits = Array.isArray(record?.traits) ? record.traits : [];
    const noteParts = [];
    for (const trait of traits) {
      const clean = normalizeText(trait);
      if (!clean || !isMeaningfulText(clean) || containsSensitive(clean)) continue;
      noteParts.push(truncateText(redactSensitive(clean).text, 120));
    }
    const note = truncateText(noteParts.join('；'), 240);
    const interactionCount = Number(record?.interactionCount);
    out.push({
      name: normalizeText(name),
      note,
      interactionCount: Number.isFinite(interactionCount) ? interactionCount : 0,
      lastSeenAt: Number(record?.lastSeenAt) || 0,
      hasTraits: noteParts.length > 0,
    });
  }
  return out;
}

function collectGroupPersons(messages, ownerQQ) {
  const people = new Map();
  let selfSeen = false;
  const selfLabels = [];
  const list = Array.isArray(messages) ? messages : [];
  list.forEach((message, index) => {
    if (!message || typeof message !== 'object') return;
    if (message.isSelf) {
      selfSeen = true;
      if (message.sender && normalizeText(message.sender) !== '我') selfLabels.push(message.sender);
      return;
    }
    const sender = normalizeText(message.sender);
    if (!sender) return;
    const userId = message.userId === undefined || message.userId === null ? '' : String(message.userId).trim();
    const key = userId ? `u:${userId}` : `n:${normalizeName(sender)}`;
    let person = people.get(key);
    if (!person) {
      person = { names: new Map(), firstIndex: index, messageCount: 0, userId, isOwner: false };
      people.set(key, person);
    }
    person.messageCount += 1;
    person.names.set(sender, (person.names.get(sender) || 0) + 1);
    if (ownerQQ && userId === ownerQQ) person.isOwner = true;
  });
  const result = new Map();
  for (const [key, person] of people) {
    let primaryName = '';
    let primaryCount = -1;
    for (const [name, count] of person.names) {
      if (count > primaryCount) {
        primaryName = name;
        primaryCount = count;
      }
    }
    const otherNames = [...person.names.keys()].filter((name) => name !== primaryName);
    result.set(key, { ...person, primaryName, otherNames, selfSeen: false });
  }
  return { people: result, selfSeen, selfLabels };
}

function ensureSelfEntity(ctx) {
  if (ctx.selfEntityName) {
    const existing = ctx.entities.get(`self|${normalizeName(ctx.selfEntityName)}`);
    if (existing) return existing;
  }
  const roleName = normalizeText(ctx.currentRoleName);
  const name = roleName || '我';
  const entity = addEntity(ctx, {
    name,
    type: 'self',
    aliases: ['我'],
    note: roleName ? `机器人自己（当前角色：${roleName}）` : '机器人自己',
    tags: ['bot', 'self'],
    source: { kind: 'state', key: ctx.roleSourceKey || 'current-role' },
  });
  if (entity) ctx.selfEntityName = entity.name;
  return entity;
}

function ensureOwnerEntity(ctx, { name, aliases = [], note = '', tags = [], sourceKey }) {
  if (ctx.ownerEntityName) {
    const existing = ctx.entities.get(`person|${normalizeName(ctx.ownerEntityName)}`);
    if (existing) {
      addEntity(ctx, {
        name: existing.name,
        type: 'person',
        aliases,
        note,
        tags: ['owner', ...tags],
        source: { kind: 'chat', key: sourceKey },
      });
      return existing;
    }
  }
  const entity = addEntity(ctx, {
    name,
    type: 'person',
    aliases: [ctx.ownerQQ, ...aliases].filter(Boolean),
    note,
    tags: ['owner', ...tags],
    source: { kind: 'chat', key: sourceKey },
  });
  if (entity) ctx.ownerEntityName = entity.name;
  return entity;
}

function processConversationMemories(ctx, convKey, conv, convEntityName) {
  const tokens = ctx.convTokens.get(convKey) ?? [];
  if (convEntityName) addConvToken(ctx, convKey, convEntityName);

  // activeTopics[] → topic 实体 + long 记忆
  const topics = Array.isArray(conv?.activeTopics) ? conv.activeTopics : [];
  // 同一会话里重复的 activeTopic（原始文本相同）只落一份实体/记忆；pendingQuestion 不参与去重，
  // 否则「带待问 + 不带待问」的同名话题会被当成两条。
  const seenRawTopics = new Set();
  for (const topic of topics) {
    const rawText = normalizeText(topic?.text);
    if (!rawText || !isMeaningfulText(rawText)) {
      ctx.stats.filtered.emptyTopic += 1;
      continue;
    }
    const rawTopicKey = `${convKey}|${rawText}`;
    if (seenRawTopics.has(rawTopicKey)) {
      ctx.stats.filtered.duplicateMemory += 1;
      continue;
    }
    seenRawTopics.add(rawTopicKey);
    const redacted = countRedactions(ctx, redactSensitive(rawText));
    const text = truncateText(redacted.text, LIMITS.memoryText);
    if (!isMeaningfulText(text)) {
      ctx.stats.filtered.emptyTopic += 1;
      continue;
    }
    const pendingQuestion = normalizeText(topic?.pendingQuestion);
    const pending = pendingQuestion && isMeaningfulText(pendingQuestion)
      ? truncateText(countRedactions(ctx, redactSensitive(pendingQuestion)).text, 200)
      : '';
    const topicName = shortTitle(text, LIMITS.entityName);
    const note = truncateText(`${text}${pending ? `；待问：${pending}` : ''}`, LIMITS.entityNote);
    const topicEntity = addEntity(ctx, {
      name: topicName,
      type: 'topic',
      aliases: [],
      note,
      tags: ['进行中话题'],
      source: { kind: 'chat', key: convKey },
    });
    if (!topicEntity) continue;
    if (convEntityName) addRelation(ctx, convEntityName, 'discussed', topicEntity.name, '会话中正在讨论的话题');
    addConvToken(ctx, convKey, topicEntity.name);
    const memoryText = `${text}${pending ? `；待问：${pending}` : ''}`;
    const entityNames = linkNamesFromText(ctx, memoryText, [topicEntity.name, convEntityName], tokens);
    addMemory(ctx, {
      text: memoryText,
      title: shortTitle(text, LIMITS.title),
      layer: 'long',
      category: 'topic',
      entityNames,
      tags: ['activeTopic', `会话:${convKey}`],
      source: { key: convKey, seqs: [] },
    });
  }

  // lastTurnSummary → long 记忆（source 带会话 key）
  const summary = conv?.lastTurnSummary;
  if (summary && isMeaningfulText(summary?.text)) {
    const redacted = countRedactions(ctx, redactSensitive(summary.text));
    const text = truncateText(redacted.text, LIMITS.memoryText);
    if (!isMeaningfulText(text)) {
      ctx.stats.filtered.sensitiveMemory += 1;
      return;
    }
    const feature = normalizeText(summary?.feature);
    const entityNames = linkNamesFromText(ctx, text, [convEntityName], tokens);
    addMemory(ctx, {
      text,
      title: shortTitle(text, LIMITS.title),
      layer: 'long',
      category: 'event',
      entityNames,
      tags: ['lastTurnSummary', ...(feature ? [`feature:${feature}`] : [])],
      source: { key: convKey, seqs: [] },
    });
  }
}

function processPrivateConversation(ctx, item) {
  const { key: convKey, id, conv } = item;
  const impressions = normalizeImpressions(conv?.memberImpressions);
  const solo = impressions.length === 1 ? impressions[0] : null;
  const isOwnerKey = Boolean(ctx.ownerQQ && String(id) === ctx.ownerQQ);

  let personName = solo?.name;
  if (!personName) personName = isOwnerKey ? '管理员' : `QQ用户 ${id}`;
  let personEntity;
  if (isOwnerKey) {
    personEntity = ensureOwnerEntity(ctx, {
      name: personName,
      aliases: [id, '主人', 'owner'],
      note: solo?.note || '',
      tags: solo?.note ? ['成员印象'] : [],
      sourceKey: convKey,
    });
  } else {
    personEntity = addEntity(ctx, {
      name: personName,
      type: 'person',
      aliases: [id],
      note: solo?.note || '',
      tags: ['私聊'],
      source: { kind: 'chat', key: convKey },
    });
  }
  // 多条成员印象（或唯一印象名与私聊对象名不同）时，把每条印象单独落成人物实体。
  if (impressions.length > 1) {
    for (const impression of impressions) {
      if (personEntity && normalizeName(impression.name) === normalizeName(personEntity.name)) {
        continue;
      }
      addEntity(ctx, {
        name: impression.name,
        type: 'person',
        aliases: [],
        note: impression.note,
        tags: ['成员印象'],
        source: { kind: 'chat', key: convKey },
      });
    }
  }
  if (!personEntity) {
    ctx.stats.filtered.badConversation += 1;
    return;
  }
  ctx.convEntities.set(convKey, personEntity.name);
  addConvToken(ctx, convKey, personEntity.name);
  for (const impression of impressions) addConvToken(ctx, convKey, personEntity.name, [impression.name]);
  addConvToken(ctx, convKey, personEntity.name, [solo?.name].filter(Boolean));

  if (isOwnerKey) {
    ctx.ownerEntityName = personEntity.name;
    addRelation(ctx, personEntity.name, 'owner_of', ctx.selfEntityName, '私聊对象是机器人主人');
  }
  processConversationMemories(ctx, convKey, conv, personEntity.name);
}

function processGroupConversation(ctx, item) {
  const { key: convKey, id, conv } = item;
  const meta = ctx.sessionMeta.get(convKey);
  const groupName = `QQ群 ${id}`;
  const noteParts = [`QQ 群 ${id}`];
  if (meta?.preset) noteParts.push(`会话预设 ${meta.preset}`);
  if (meta?.variant) noteParts.push(`当前变体 ${meta.variant}`);
  const tags = [
    '群聊',
    ...(meta?.preset ? [`预设:${meta.preset}`] : []),
    ...(meta?.variant ? [`变体:${meta.variant}`] : []),
  ];
  const groupEntity = addEntity(ctx, {
    name: groupName,
    type: 'group',
    aliases: [id],
    note: noteParts.join('；'),
    tags,
    source: { kind: 'chat', key: convKey },
  });
  if (!groupEntity) {
    ctx.stats.filtered.badConversation += 1;
    return;
  }
  ctx.convEntities.set(convKey, groupEntity.name);
  addConvToken(ctx, convKey, groupEntity.name);

  const impressions = normalizeImpressions(conv?.memberImpressions);
  const matchedImpressionNames = new Set();
  const { people, selfSeen, selfLabels } = collectGroupPersons(conv?.recentMessages, ctx.ownerQQ);

  for (const person of people.values()) {
    const impression = impressions.find((item) => person.names.has(item.name));
    let entity = null;
    if (person.isOwner) {
      entity = ensureOwnerEntity(ctx, {
        name: ctx.ownerEntityName || person.primaryName,
        aliases: [person.primaryName, ...person.otherNames],
        sourceKey: convKey,
      });
      if (impression) matchedImpressionNames.add(impression.name);
      if (entity && impression?.note) {
        addEntity(ctx, {
          name: entity.name,
          type: 'person',
          aliases: [],
          note: impression.note,
          tags: ['成员印象'],
          source: { kind: 'chat', key: convKey },
        });
      }
    } else {
      const note = impression?.note || '';
      entity = addEntity(ctx, {
        name: person.primaryName,
        type: 'person',
        aliases: person.otherNames,
        note,
        tags: ['群友', ...(impression ? ['成员印象'] : [])],
        source: { kind: 'chat', key: convKey },
      });
      if (impression) matchedImpressionNames.add(impression.name);
    }
    if (!entity) continue;
    addRelation(ctx, entity.name, 'member_of', groupEntity.name, '群成员');
    addConvToken(ctx, convKey, entity.name, [person.primaryName, ...person.names.keys()]);
  }

  // 群里出现但没对上人名的成员印象：仍落人物实体（note=印象），不硬造 member_of。
  for (const impression of impressions) {
    if (matchedImpressionNames.has(impression.name)) continue;
    addEntity(ctx, {
      name: impression.name,
      type: 'person',
      aliases: [],
      note: impression.note,
      tags: ['成员印象'],
      source: { kind: 'chat', key: convKey },
    });
  }

  if (selfSeen && ctx.selfEntityName) {
    const selfEntity = ctx.entities.get(`self|${normalizeName(ctx.selfEntityName)}`);
    if (selfEntity) {
      if (selfLabels.length) {
        addEntity(ctx, {
          name: selfEntity.name,
          type: 'self',
          aliases: selfLabels,
          tags: [],
          source: { kind: 'chat', key: convKey },
        });
      }
      addRelation(ctx, selfEntity.name, 'member_of', groupEntity.name, '机器人在群里');
      addConvToken(ctx, convKey, selfEntity.name, selfLabels);
    }
  }

  processConversationMemories(ctx, convKey, conv, groupEntity.name);
}

function buildFromSocial(ctx, social) {
  const conversations = social?.conversations;
  if (!conversations || typeof conversations !== 'object' || Array.isArray(conversations)) {
    ctx.warnings.push('social-v2.json 缺少 conversations 对象，跳过会话导入');
    return;
  }
  const items = [];
  for (const key of Object.keys(conversations).sort(compareStrings)) {
    const match = /^(group|private):(.+)$/.exec(key);
    if (!match) {
      ctx.stats.filtered.unknownConversation += 1;
      ctx.warnings.push(`跳过无法识别的会话 key：${key}`);
      continue;
    }
    const conv = conversations[key];
    if (!conv || typeof conv !== 'object' || Array.isArray(conv)) {
      ctx.stats.filtered.badConversation += 1;
      continue;
    }
    items.push({ key, kind: match[1], id: match[2].trim(), conv });
  }
  // 先处理私聊：确定 owner 人物实体与 self 关系，再处理群聊（群成员里若出现 ownerQQ 可合并）。
  for (const item of items.filter((entry) => entry.kind === 'private')) processPrivateConversation(ctx, item);
  for (const item of items.filter((entry) => entry.kind === 'group')) processGroupConversation(ctx, item);
}

// ---------------------------------------------------------------------------
// state/sessions.json → 会话实体 tags/note（sessionPolicies 无可靠图目标，不硬造实体）
// ---------------------------------------------------------------------------

function readSessionMeta(sessions) {
  const meta = new Map();
  if (!sessions || typeof sessions !== 'object') return meta;
  const ensure = (key) => {
    if (!meta.has(key)) meta.set(key, { preset: '', variant: '' });
    return meta.get(key);
  };
  const policies = sessions.sessionPolicies;
  if (policies && typeof policies === 'object') {
    for (const key of Object.keys(policies).sort(compareStrings)) {
      let value = policies[key];
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          /* 保留原字符串 */
        }
      }
      const entry = ensure(key);
      if (Array.isArray(value)) {
        entry.preset = normalizeText(value[0]);
        if (!entry.variant && typeof value[1] === 'string') entry.variant = '';
      } else if (typeof value === 'string') {
        entry.preset = normalizeText(value);
      }
    }
  }
  const variants = sessions.sessionVariants;
  if (variants && typeof variants === 'object') {
    for (const key of Object.keys(variants).sort(compareStrings)) {
      const value = normalizeText(variants[key]);
      if (value) ensure(key).variant = value;
    }
  }
  return meta;
}

// ---------------------------------------------------------------------------
// state/slang.json → term 实体 + related 关系
// ---------------------------------------------------------------------------

function isAcceptedSlang(entry, strictSlang) {
  const status = normalizeText(entry?.status);
  const meaning = normalizeText(entry?.meaning);
  if (status === 'rejected') return false;
  if (status === 'confirmed') return Boolean(meaning);
  if (strictSlang) return false;
  // 真实数据里 confirmed 可能为 0：默认把「有释义的 candidate」也导入，note 标注待确认。
  return Boolean(meaning);
}

function processSlang(ctx, slang) {
  if (!Array.isArray(slang)) {
    if (slang !== null) ctx.warnings.push('slang.json 顶层不是数组，跳过黑话导入');
    return;
  }
  for (const entry of slang) {
    if (!entry || typeof entry !== 'object') continue;
    if (!isAcceptedSlang(entry, ctx.strictSlang)) {
      ctx.stats.filtered.slangSkipped += 1;
      continue;
    }
    const content = normalizeText(entry.content);
    if (!content || !isMeaningfulText(content) || containsSensitive(content)) {
      ctx.stats.filtered.slangSkipped += 1;
      continue;
    }
    const status = normalizeText(entry.status) || 'candidate';
    const meaning = normalizeText(entry.meaning);
    const usage = normalizeText(entry.usage);
    const example = normalizeText(entry.example);
    const noteParts = [`含义：${truncateText(countRedactions(ctx, redactSensitive(meaning)).text, 160)}`];
    if (usage && isMeaningfulText(usage)) {
      noteParts.push(`用法：${truncateText(countRedactions(ctx, redactSensitive(usage)).text, 120)}`);
    }
    if (example && isMeaningfulText(example)) {
      noteParts.push(`例句：${truncateText(countRedactions(ctx, redactSensitive(example)).text, 160)}`);
    }
    const entity = addEntity(ctx, {
      name: content,
      type: 'term',
      aliases: [],
      note: truncateText(noteParts.join('；'), LIMITS.entityNote),
      tags: ['黑话', status === 'confirmed' ? '已确认' : '待人工确认'],
      source: { kind: 'slang', key: normalizeText(entry.id) || content },
    });
    if (!entity) continue;

    const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
    const seenConversations = new Set();
    const seenPeople = new Set();
    for (const item of evidence) {
      if (!item || typeof item !== 'object') continue;
      const convKey = normalizeText(item.key);
      if (convKey && !seenConversations.has(convKey)) {
        seenConversations.add(convKey);
        const convEntityName = ctx.convEntities.get(convKey);
        if (convEntityName) {
          addRelation(ctx, convEntityName, 'related', entity.name, '该会话中出现过这个词');
        }
      }
      const sender = normalizeText(item.sender);
      if (!sender || seenPeople.has(normalizeName(sender))) continue;
      const personName = ctx.personTokens.get(normalizeName(sender));
      if (personName) {
        seenPeople.add(normalizeName(sender));
        addRelation(ctx, personName, 'related', entity.name, '使用过这个词');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 可选：DSH session 归档 → 助手回复 long 记忆
// ---------------------------------------------------------------------------

function findSessionFile(sessionsRoot, sessionId) {
  if (!sessionsRoot || !sessionId || !fs.existsSync(sessionsRoot)) return null;
  let workspaceDirs = [];
  try {
    workspaceDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const dirent of workspaceDirs) {
    if (!dirent.isDirectory()) continue;
    const sessionDir = path.join(sessionsRoot, dirent.name, sessionId);
    let files = [];
    try {
      if (!fs.existsSync(sessionDir)) continue;
      files = fs.readdirSync(sessionDir);
    } catch {
      continue;
    }
    const candidates = [
      'session.v4.jsonl.zstd',
      'session.v3.jsonl.zstd',
      'session.v2.jsonl.zstd',
      'session.jsonl.zstd',
      'session.v4.jsonl',
      'session.jsonl',
    ].filter((name) => files.includes(name));
    if (candidates.length) return path.join(sessionDir, candidates[0]);
    const fallback = files
      .filter((name) => /^session.*\.jsonl(?:\.zstd)?$/.test(name))
      .sort(compareStrings);
    if (fallback.length) return path.join(sessionDir, fallback[fallback.length - 1]);
  }
  return null;
}

function collectSessionMappings(sessions) {
  const mappings = [];
  const seen = new Set();
  const push = (convKey, sessionId) => {
    const key = normalizeText(convKey);
    const id = normalizeText(sessionId);
    if (!key || !id || seen.has(`${key}|${id}`)) return;
    seen.add(`${key}|${id}`);
    mappings.push({ convKey: key, sessionId: id });
  };
  const primary = sessions?.sessions;
  if (primary && typeof primary === 'object') {
    for (const key of Object.keys(primary).sort(compareStrings)) push(key, primary[key]);
  }
  const parked = sessions?.parkedSessions;
  if (parked && typeof parked === 'object') {
    for (const key of Object.keys(parked).sort(compareStrings)) {
      const variants = parked[key];
      if (!variants || typeof variants !== 'object') continue;
      for (const feature of Object.keys(variants).sort(compareStrings)) {
        push(key, variants[feature]?.sessionId);
      }
    }
  }
  return mappings;
}

function processSessionArchives(ctx, sessions, sessionsRoot) {
  const mappings = collectSessionMappings(sessions);
  if (!mappings.length) {
    ctx.warnings.push('--include-sessions：sessions.json 里没有可映射的 sessionId');
    return;
  }
  let processedAny = false;
  for (const { convKey, sessionId } of mappings) {
    const convEntityName = ctx.convEntities.get(convKey);
    if (!convEntityName) continue; // 没有对应会话实体时不导入，避免孤儿记忆
    const filePath = findSessionFile(sessionsRoot, sessionId);
    if (!filePath) {
      continue;
    }
    let buffer;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > LIMITS.sessionArchiveMaxBytes) {
        ctx.stats.archives.skipped += 1;
        ctx.warnings.push(`跳过过大的会话归档（${Math.round(stat.size / 1024)} KB）：${sessionId}`);
        continue;
      }
      buffer = fs.readFileSync(filePath);
    } catch (error) {
      ctx.warnings.push(`读取会话归档失败（${sessionId}）：${error.message}`);
      continue;
    }
    let records;
    try {
      const text = filePath.endsWith('.zstd')
        ? decompressZstdArchive(buffer).toString('utf8')
        : buffer.toString('utf8');
      if (filePath.endsWith('.zstd')) {
        try {
          ctx.stats.archives.frames += splitZstdFrames(buffer).length;
        } catch {
          /* frames 统计失败不影响导入 */
        }
      }
      const parsed = parseJsonl(text);
      records = parsed.records;
      ctx.stats.archives.badLines += parsed.badLines;
    } catch (error) {
      ctx.warnings.push(`解码会话归档失败（${sessionId}）：${error.message}`);
      continue;
    }
    processedAny = true;
    ctx.stats.archives.files += 1;
    ctx.stats.archives.records += records.length;
    const texts = [];
    const seenTexts = new Set();
    for (const raw of extractAssistantTexts(records)) {
      if (!isMeaningfulText(raw) || looksLikeEmojiOnly(raw)) continue;
      const redacted = countRedactions(ctx, redactSensitive(raw));
      const text = truncateText(redacted.text, LIMITS.sessionArchiveText);
      if (!isMeaningfulText(text)) continue;
      const key = normalizeText(text);
      if (seenTexts.has(key)) continue;
      seenTexts.add(key);
      texts.push(text);
    }
    const selected = texts.slice(-LIMITS.sessionArchivePerConversation);
    ctx.stats.archives.assistantTexts += selected.length;
    for (const text of selected) {
      addMemory(ctx, {
        text,
        title: '对话归档 · 助手回复',
        layer: 'long',
        category: 'event',
        entityNames: [convEntityName],
        tags: ['sessionArchive', 'assistant'],
        source: { key: convKey, seqs: [] },
      });
    }
  }
  if (processedAny) {
    ctx.sources.push('dsh-sessions/');
  } else {
    ctx.warnings.push('--include-sessions：没有找到可读取的会话归档');
  }
}

// ---------------------------------------------------------------------------
// 汇总 / 输出
// ---------------------------------------------------------------------------

function plainEntity(entity) {
  return {
    name: entity.name,
    type: entity.type,
    aliases: [...entity.aliases],
    note: entity.note,
    tags: [...entity.tags],
    source: { ...entity.source },
  };
}

function plainRelation(relation) {
  return {
    from: relation.from,
    to: relation.to,
    relation: relation.relation,
    note: relation.note,
  };
}

function plainMemory(memory) {
  return {
    text: memory.text,
    title: memory.title,
    layer: memory.layer,
    category: memory.category,
    keywords: [...memory.keywords],
    entityNames: [...memory.entityNames],
    tags: [...memory.tags],
    protection: memory.protection,
    source: { key: memory.source.key, seqs: [...memory.source.seqs] },
  };
}

function typeOrder(type) {
  const index = ENTITY_TYPE_ORDER.indexOf(type);
  return index === -1 ? ENTITY_TYPE_ORDER.length : index;
}

function countBy(items, pick) {
  const out = {};
  for (const item of items) {
    const key = pick(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function finalizeSeed(ctx, { sources, now }) {
  const entities = [...ctx.entities.values()]
    .sort((left, right) => typeOrder(left.type) - typeOrder(right.type) || compareStrings(left.name, right.name))
    .map(plainEntity);
  const entityNames = new Set(entities.map((entity) => entity.name));

  const relations = [];
  for (const relation of ctx.relations.values()) {
    if (!entityNames.has(relation.from) || !entityNames.has(relation.to)) {
      ctx.stats.filtered.unresolvedRelation += 1;
      continue;
    }
    relations.push(plainRelation(relation));
  }
  relations.sort(
    (left, right) =>
      compareStrings(left.from, right.from) ||
      compareStrings(left.relation, right.relation) ||
      compareStrings(left.to, right.to),
  );

  const memories = [];
  for (const memory of ctx.memories.values()) {
    const keptEntityNames = [];
    for (const name of memory.entityNames) {
      if (!name || keptEntityNames.includes(name)) continue;
      if (!entityNames.has(name)) {
        ctx.stats.filtered.unresolvedEntityRef += 1;
        continue;
      }
      keptEntityNames.push(name);
      if (keptEntityNames.length >= LIMITS.entityNamesPerMemory) break;
    }
    memories.push(plainMemory({ ...memory, entityNames: keptEntityNames }));
  }
  memories.sort(
    (left, right) =>
      compareStrings(left.source.key, right.source.key) ||
      compareStrings(left.text, right.text),
  );

  const seed = {
    version: SEED_VERSION,
    generatedAt: now,
    sources: [...sources],
    entities,
    relations,
    memories,
  };
  return { seed, stats: summarize(seed, ctx, now) };
}

function summarize(seed, ctx, now) {
  const entityByType = countBy(seed.entities, (entity) => entity.type);
  const relationByType = countBy(seed.relations, (relation) => relation.relation);
  const memoryByLayer = countBy(seed.memories, (memory) => memory.layer);
  const memoryByCategory = countBy(seed.memories, (memory) => memory.category);
  return {
    generatedAt: now,
    sources: [...seed.sources],
    entities: { total: seed.entities.length, byType: entityByType },
    relations: { total: seed.relations.length, byType: relationByType },
    memories: { total: seed.memories.length, byLayer: memoryByLayer, byCategory: memoryByCategory },
    filtered: { ...ctx.stats.filtered },
    redactions: ctx.stats.redactions,
    archives: { ...ctx.stats.archives },
    warnings: [...ctx.warnings],
  };
}

function printStats(stats, meta) {
  if (meta.json) {
    console.log(JSON.stringify({ ...stats, output: meta.outFile, written: meta.written, bytes: meta.bytes, unchanged: meta.unchanged, durationMs: meta.durationMs }, null, 2));
    return;
  }
  const format = (record) =>
    Object.entries(record)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, value]) => `${key} ${value}`)
      .join(' / ') || '无';
  console.log(`[memory-bootstrap] 数据源：${stats.sources.join(', ') || '无'}`);
  console.log(
    `[memory-bootstrap] 实体 ${stats.entities.total}（${format(stats.entities.byType)}）`,
  );
  console.log(
    `[memory-bootstrap] 关系 ${stats.relations.total}（${format(stats.relations.byType)}）`,
  );
  console.log(
    `[memory-bootstrap] 记忆 ${stats.memories.total}（${format(stats.memories.byLayer)}；分类 ${format(stats.memories.byCategory)}）`,
  );
  const filtered = stats.filtered;
  console.log(
    `[memory-bootstrap] 过滤：空/纯表情 实体 ${filtered.emptyEntity} 话题 ${filtered.emptyTopic} 记忆 ${filtered.emptyMemory}、` +
      `敏感 实体 ${filtered.sensitiveEntity} 记忆 ${filtered.sensitiveMemory}、` +
      `重复 实体 ${filtered.duplicateEntity} 记忆 ${filtered.duplicateMemory} 关系 ${filtered.duplicateRelation}、` +
      `悬空关系 ${filtered.unresolvedRelation} 未解析实体引用 ${filtered.unresolvedEntityRef}、` +
      `跳过黑话 ${filtered.slangSkipped}、未知会话 ${filtered.unknownConversation}`,
  );
  console.log(`[memory-bootstrap] 脱敏：${stats.redactions} 处`);
  if (stats.archives.files > 0) {
    console.log(
      `[memory-bootstrap] 会话归档：文件 ${stats.archives.files}、帧 ${stats.archives.frames}、` +
        `记录 ${stats.archives.records}、助手文本 ${stats.archives.assistantTexts}、新增记忆 ${stats.archives.memories}`,
    );
  }
  for (const warning of stats.warnings) console.log(`[memory-bootstrap] ⚠ ${warning}`);
  const sizeText = meta.bytes >= 1024 ? `${(meta.bytes / 1024).toFixed(1)} KB` : `${meta.bytes} B`;
  console.log(
    `[memory-bootstrap] ${meta.written ? '写入' : '未变化'}：${meta.outFile}（${sizeText}，${meta.durationMs} ms）`,
  );
}

function writeSeedAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      /* 清理失败忽略 */
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export function buildSeedFromData({
  social = null,
  sessions = null,
  slang = null,
  currentRole = null,
  roleSourceKey = 'current-role',
  now = Date.now(),
  strictSlang = false,
  ownerQQ = null,
  sources = [],
  warnings = [],
  includeSessions = false,
  sessionsDir = null,
}) {
  const ctx = createContext({ now, strictSlang, sources, warnings, ownerQQ });
  ctx.currentRoleName = normalizeText(currentRole?.role);
  ctx.roleSourceKey = roleSourceKey;

  ensureSelfEntity(ctx);

  // sessions.json 的预设/变体信息挂在会话实体 tags 上（先读，供群实体构造 note）。
  ctx.sessionMeta = readSessionMeta(sessions);

  buildFromSocial(ctx, social);
  processSlang(ctx, slang);
  if (includeSessions) {
    processSessionArchives(ctx, sessions, sessionsDir || path.join(os.homedir(), '.dsh', 'sessions'));
  }

  // owner / self 关系兜底（群聊里才认出 owner 的情况）
  if (ctx.ownerEntityName && ctx.selfEntityName) {
    addRelation(ctx, ctx.ownerEntityName, 'owner_of', ctx.selfEntityName, '机器人主人');
  }

  const { seed, stats } = finalizeSeed(ctx, { sources, now });
  stats.archives.memories = seed.memories.filter((memory) =>
    memory.tags.includes('sessionArchive'),
  ).length;
  return { seed, stats };
}

export function loadData({ stateDir, ownerQQOverride = null, includeSessions = false, sessionsDir = null }) {
  const warnings = [];
  const sources = [];
  const socialPath = path.join(stateDir, 'social-v2.json');
  const sessionsPath = path.join(stateDir, 'sessions.json');
  const slangPath = path.join(stateDir, 'slang.json');
  const rolePath = path.join(stateDir, 'current-role.json');
  const configPath = path.join(REPO_ROOT, 'config.json');

  const social = readJson(socialPath, warnings);
  if (social !== null) sources.push(labelPath(socialPath));
  const sessions = readJson(sessionsPath, warnings);
  if (sessions !== null) sources.push(labelPath(sessionsPath));
  const slang = readJson(slangPath, warnings);
  if (slang !== null) sources.push(labelPath(slangPath));
  const currentRole = readJson(rolePath, warnings);
  if (currentRole !== null) sources.push(labelPath(rolePath));

  let ownerQQ = ownerQQOverride ? String(ownerQQOverride) : null;
  if (!ownerQQ) {
    const config = readJson(configPath, warnings);
    if (config && config.ownerQQ !== undefined && config.ownerQQ !== null) {
      ownerQQ = String(config.ownerQQ);
      sources.push(labelPath(configPath));
    }
  }

  if (social === null && sessions === null && slang === null) {
    throw new Error(`找不到任何数据源（state 目录：${stateDir}）。需要至少一个：social-v2.json / sessions.json / slang.json`);
  }

  return {
    social,
    sessions,
    slang,
    currentRole,
    ownerQQ,
    sources,
    warnings,
    roleSourceKey: currentRole !== null ? labelPath(rolePath) : 'current-role',
    includeSessions,
    sessionsDir,
  };
}

export function generateSeed({
  stateDir = path.join(REPO_ROOT, 'state'),
  now = Date.now(),
  strictSlang = false,
  ownerQQ = null,
  includeSessions = false,
  sessionsDir = null,
} = {}) {
  const loaded = loadData({ stateDir, ownerQQOverride: ownerQQ, includeSessions, sessionsDir });
  const { seed, stats } = buildSeedFromData({
    ...loaded,
    now,
    strictSlang,
    sources: [...loaded.sources],
    warnings: [...loaded.warnings],
  });
  return { seed, stats, data: loaded };
}

function main() {
  const startedAt = Date.now();
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[memory-bootstrap] 参数错误：${error.message}`);
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    console.log(usage());
    return;
  }
  const stateDir = path.resolve(opts.state || path.join(REPO_ROOT, 'state'));
  const outFile = path.resolve(opts.out || path.join(stateDir, 'memory', 'seed.json'));
  const now = opts.now || Date.now();

  let result;
  try {
    result = generateSeed({
      stateDir,
      now,
      strictSlang: opts.strictSlang,
      ownerQQ: opts.ownerQQ,
      includeSessions: opts.includeSessions,
      sessionsDir: opts.sessionsDir || null,
    });
  } catch (error) {
    console.error(`[memory-bootstrap] 生成失败：${error.message}`);
    process.exitCode = 1;
    return;
  }

  const content = `${JSON.stringify(result.seed, null, 2)}\n`;
  const bytes = Buffer.byteLength(content, 'utf8');
  let written = false;
  let unchanged = false;
  if (!opts.dryRun) {
    try {
      const existing = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : null;
      if (existing === content) {
        unchanged = true;
      } else {
        writeSeedAtomic(outFile, content);
        written = true;
      }
    } catch (error) {
      console.error(`[memory-bootstrap] 写入失败：${error.message}`);
      process.exitCode = 1;
      return;
    }
  }
  printStats(result.stats, {
    json: opts.json,
    outFile: opts.dryRun ? '(dry-run)' : labelPath(outFile),
    written,
    unchanged,
    bytes,
    durationMs: Date.now() - startedAt,
  });
  if (opts.dryRun && !opts.json) {
    console.log(`[memory-bootstrap] --dry-run：未写文件（${labelPath(outFile)}）`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
