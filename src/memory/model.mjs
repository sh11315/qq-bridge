// 记忆系统 —— 纯函数模型层（无 fs / 无网络 / 无副作用）。
//
// 契约来源：docs/guides/MEMORY_SYSTEM.md §3 数据模型 / §4 配置 / §5 持久化。
// 这里只放可独立测试的纯函数：衰减公式、状态机、关键词分词、去重相似度、ID、排序、
// 配置默认值/归一化、快照整理。store.mjs（持久化）与 service.mjs（业务）依赖本文件。
import { createHash } from 'node:crypto';
import { salienceScore, salienceTier, SALIENCE_TIERS } from './salience.mjs';

export const MEMORY_VERSION = 1;

export const MEMORY_LAYERS = Object.freeze(['long', 'short']);
export const MEMORY_CATEGORIES = Object.freeze([
  'fact',
  'preference',
  'event',
  'relationship',
  'promise',
  'topic',
  'profile',
  'day',
  'other',
]);
// 2026-10-28 v1.3：新增 superseded（被新决策取代/降权）。它既不是归档也不是衰减，
// 保留在库里做时间线，只是不再默认参与召回（详见 detectContradiction）。
export const MEMORY_STATUSES = Object.freeze(['active', 'fading', 'faded', 'archived', 'superseded']);
export const ENTITY_TYPES = Object.freeze(['person', 'group', 'topic', 'term', 'event', 'project', 'self']);

/**
 * 实体关系类型（NeuralMemory 风格）：20 种关系分 5 大类。
 * 时间：事件先后 / 因果：谁导致谁 / 语义：归属继承 / 情绪：主观反馈 / 冲突：旧结论被新结论覆盖。
 */
export const RELATION_TYPE_GROUPS = Object.freeze({
  temporal: Object.freeze(['BEFORE', 'AFTER', 'DURING', 'SIMULTANEOUS']),
  causal: Object.freeze(['CAUSED_BY', 'LEADS_TO', 'ENABLES', 'PREVENTS']),
  semantic: Object.freeze(['IS_A', 'HAS_PROPERTY', 'PART_OF', 'INSTANCE_OF']),
  emotional: Object.freeze(['FELT', 'EVOKES', 'PREFERRED', 'AVOID']),
  conflict: Object.freeze(['CONTRADICTS', 'SUPERSEDES', 'INVALIDATES', 'REPLACES']),
});

export const RELATION_TYPES = Object.freeze(
  Object.values(RELATION_TYPE_GROUPS).flatMap((types) => types),
);

/** 历史类型（v1.3 之前写入的）：保留以兼容旧数据，展示归入「历史」。 */
export const RELATION_LEGACY_TYPES = Object.freeze(['knows', 'related', 'alias_of']);

/** 旧类型 → 新规范类型（member_of/owner_of 都是「属于」）。 */
export const LEGACY_RELATION_ALIASES = Object.freeze({
  member_of: 'PART_OF',
  part_of: 'PART_OF',
  owner_of: 'PART_OF',
  likes: 'PREFERRED',
  discussed: 'DURING',
});

export const RELATION_TYPE_LABELS = Object.freeze({
  BEFORE: '早于',
  AFTER: '晚于',
  DURING: '发生于',
  SIMULTANEOUS: '同时',
  CAUSED_BY: '由…导致',
  LEADS_TO: '导致',
  ENABLES: '使能',
  PREVENTS: '阻止',
  IS_A: '是…类',
  HAS_PROPERTY: '具有属性',
  PART_OF: '属于',
  INSTANCE_OF: '是…实例',
  FELT: '感受为',
  EVOKES: '唤起',
  PREFERRED: '偏好',
  AVOID: '回避',
  CONTRADICTS: '与…矛盾',
  SUPERSEDES: '取代',
  INVALIDATES: '使失效',
  REPLACES: '替换',
  knows: '认识',
  related: '相关',
  alias_of: '别名',
});

/** 把任意写法（旧类型/小写/别名）归一成规范关系类型。 */
export function normalizeRelationType(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return 'related';
  const upper = value.toUpperCase();
  if (RELATION_TYPES.includes(upper)) return upper;
  const lower = value.toLowerCase();
  if (LEGACY_RELATION_ALIASES[lower]) return LEGACY_RELATION_ALIASES[lower];
  if (RELATION_LEGACY_TYPES.includes(lower)) return lower;
  return 'related';
}

/** 关系类型所属大类（时间/因果/语义/情绪/冲突；历史类型返回 legacy）。 */
export function relationGroupOf(type) {
  const normalized = normalizeRelationType(type);
  for (const [group, types] of Object.entries(RELATION_TYPE_GROUPS)) {
    if (types.includes(normalized)) return group;
  }
  return 'legacy';
}

export function relationLabelOf(type) {
  return RELATION_TYPE_LABELS[normalizeRelationType(type)] || String(type || '相关');
}

export const DAY_MS = 86_400_000;
export const FADE_THRESHOLD = 0.15;
export const FORGET_THRESHOLD = 0.05;
export const FADING_PURGE_GRACE_DAYS = 7;
export const PERMANENT_PROTECTION = 1;

/** §4 配置默认值（state/memory/config.json 可覆盖）。 */
export const DEFAULT_CONFIG = Object.freeze({
  decayDaysLong: 200,
  decayDaysShort: 30,
  // 遗忘曲线：linear（默认，可预测归档）或 ebbinghaus（指数遗忘）
  decayCurve: 'linear',
  protectionLine: 0.5,
  fadeThreshold: FADE_THRESHOLD,
  forgetThreshold: FORGET_THRESHOLD,
  purgeGraceDays: FADING_PURGE_GRACE_DAYS,
  defaultLayer: 'short',
  defaultCategory: 'other',
  maxMemories: 5000,
  // v1.6：容量按层拆分——长期层单独配额，短期层保持高淘汰。
  maxMemoriesLong: 20000,
  maxMemoriesShort: 5000,
  // v1.6：同主题+同类别进展聚合（consolidate 时间合并）：保留最新 N 条 + 1 条摘要。
  progressKeep: 3,
  progressMergeMin: 4,
  maxMemoriesPerEntityLink: 50,
  lockTimeoutMs: 5000,
  backupKeep: 5,
  eventLogKeepBytes: 5_242_880,
  vaultDir: 'memory-vault',
});

// ---------------------------------------------------------------------------
// v1.5-lite：人格状态（精力 / 心情）——只存状态，不写进记忆。
// 注入时用"感受词"表达，数字只用于内部漂移计算。
// ---------------------------------------------------------------------------

export const DEFAULT_PERSONA_STATE = Object.freeze({ energy: 0.6, mood: 0, updatedAt: 0 });
﻿export const SELF_NARRATIVE_LIMIT = 200;
export const PERSONA_STATUSES = Object.freeze(['none', 'pending', 'approved', 'rejected']);
export const PERSONA_ANCHOR_MAX = 300;
export const PERSONA_APPROVE_COOLDOWN_MS = 6 * 3_600_000;
export const SELF_VALUE_LIMIT = 50;
export const SELF_DIGEST_LIMIT = 20;

/** v1.5-lite 第二批：自述（只增不改）+ 人设建议（主人批准）。 */
export function emptySelf() {
  return {
    anchor: '',
    narratives: [],
    values: [],
    digests: [],
    // v1.7：自升级候选提案（只有主人批准才生效）与已生效的语气提示。
    proposals: [],
    toneHints: [],
    persona: { text: '', status: 'none', at: 0, by: '', approvedAt: 0 },
  };
}

export function normalizeSelf(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = Array.isArray(value.narratives) ? value.narratives : [];
  const narratives = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const text = normalizeText(item.text);
    if (!text) continue;
    narratives.push({ id: String(item.id || `self_${sha1(text).slice(0, 12)}`), text, at: Number(item.at) || 0 });
    if (narratives.length >= SELF_NARRATIVE_LIMIT) break;
  }
  const personaRaw = value.persona && typeof value.persona === 'object' ? value.persona : {};
  const status = PERSONA_STATUSES.includes(String(personaRaw.status || '')) ? String(personaRaw.status) : 'none';
  const values = [];
  for (const item of Array.isArray(value.values) ? value.values : []) {
    if (!item || typeof item !== 'object') continue;
    const text = normalizeText(item.text);
    if (!text) continue;
    values.push({ id: String(item.id || `val_${sha1(text).slice(0, 12)}`), text: text.slice(0, 300), at: Number(item.at) || 0, by: String(item.by || 'self') });
    if (values.length >= SELF_VALUE_LIMIT) break;
  }
  const digests = [];
  for (const item of Array.isArray(value.digests) ? value.digests : []) {
    if (!item || typeof item !== 'object') continue;
    const text = normalizeText(item.text);
    if (!text) continue;
    digests.push({ id: String(item.id || `dig_${sha1(text).slice(0, 12)}`), text: text.slice(0, 2000), at: Number(item.at) || 0, count: Number(item.count) || 0 });
    if (digests.length >= SELF_DIGEST_LIMIT) break;
  }
  // v1.7：自升级提案（pending/approved/rejected），只接受白名单状态。
  const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected'];
  const proposals = [];
  for (const item of Array.isArray(value.proposals) ? value.proposals : []) {
    if (!item || typeof item !== 'object') continue;
    const title = normalizeText(item.title);
    const detail = normalizeText(item.detail);
    if (!title && !detail) continue;
    const status = PROPOSAL_STATUSES.includes(String(item.status || '')) ? String(item.status) : 'pending';
    const evidence = [];
    for (const ev of Array.isArray(item.evidence) ? item.evidence : []) {
      if (!ev || typeof ev !== 'object') continue;
      const text = normalizeText(ev.text);
      if (!text) continue;
      evidence.push({ text: text.slice(0, 200), at: Number(ev.at) || 0 });
      if (evidence.length >= 5) break;
    }
    proposals.push({
      id: String(item.id || `prop_${sha1(`${title}|${detail}`).slice(0, 12)}`),
      kind: String(item.kind || 'tone'),
      rubricId: String(item.rubricId || ''),
      title: title.slice(0, 200),
      detail: detail.slice(0, 800),
      evidence,
      status,
      createdAt: Number(item.createdAt) || 0,
      decidedAt: Number(item.decidedAt) || 0,
      by: String(item.by || ''),
      selfScore: clamp(Number(item.selfScore) || 0, 0, 1),
      externalScore: item.externalScore === null || item.externalScore === undefined ? null : clamp(Number(item.externalScore) || 0, 0, 1),
    });
    if (proposals.length >= 60) break;
  }
  const toneHints = [];
  for (const item of Array.isArray(value.toneHints) ? value.toneHints : []) {
    const text = normalizeText(item && typeof item === 'object' ? item.text : item);
    if (!text) continue;
    toneHints.push(text.slice(0, 500));
    if (toneHints.length >= 20) break;
  }
  return {
    anchor: normalizeText(value.anchor).slice(0, PERSONA_ANCHOR_MAX),
    narratives,
    values,
    digests,
    proposals,
    toneHints,
    persona: { text: normalizeText(personaRaw.text), status, at: Number(personaRaw.at) || 0, by: String(personaRaw.by || ''), approvedAt: Number(personaRaw.approvedAt) || 0 },
  };
}

/** 日层记忆：每天压缩的一小段“那阵子大概发生了什么”，注入时不算普通名额。 */
export function isDayMemory(memory) {
  if (!memory) return false;
  if (String(memory.category || '') === 'day') return true;
  return Array.isArray(memory.tags) && memory.tags.map((tag) => String(tag).toLowerCase()).includes('day');
}


export function normalizePersonaState(raw, now = Date.now()) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    energy: clamp(Number(value.energy ?? DEFAULT_PERSONA_STATE.energy), 0.05, 0.95),
    mood: clamp(Number(value.mood ?? DEFAULT_PERSONA_STATE.mood), -1, 1),
    updatedAt: Number(value.updatedAt) || Number(now),
  };
}

/** 昼夜基线：上午 10 点附近最高、凌晨最低。 */
export function circadianBaseline(now = Date.now()) {
  const hour = new Date(now).getHours() + new Date(now).getMinutes() / 60;
  return clamp(0.5 + 0.28 * Math.sin(((hour - 10) / 24) * Math.PI * 2), 0.15, 0.95);
}

/**
 * 把状态物化到 now：精力向昼夜基线漂移（约 8 小时半衰），心情随时间平复（约 6 小时半衰）。
 * 返回值给注入层用"感受词"表达，不直接给模型数字。
 */
export function personaStateSnapshot(state, now = Date.now()) {
  const normalized = normalizePersonaState(state, now);
  const hours = normalized.updatedAt ? clamp((Number(now) - normalized.updatedAt) / 3_600_000, 0, 72) : 0;
  const baseline = circadianBaseline(now);
  const energy = clamp(normalized.energy + (baseline - normalized.energy) * (1 - Math.exp(-hours / 8)), 0.05, 0.95);
  const mood = clamp(normalized.mood * Math.exp(-hours / 6), -1, 1);
  const energyWord = energy >= 0.78 ? '精神很足' : energy >= 0.6 ? '状态还行' : energy >= 0.42 ? '有点乏' : '很困';
  const moodWord = mood > 0.45 ? '心情挺好' : mood > 0.15 ? '还不错' : mood < -0.45 ? '情绪有点低' : mood < -0.15 ? '有点闷' : '平静';
  return {
    energy: Math.round(energy * 100) / 100,
    mood: Math.round(mood * 100) / 100,
    baseline: Math.round(baseline * 100) / 100,
    energyWord,
    moodWord,
    hours: Math.round(hours * 10) / 10,
    at: Number(now),
  };
}

/**
 * 置顶等级：2 = 永远放在上下文里（关系/约定/身体类，或手动 pinned），1 = 普通。
 * 置顶不占普通名额。
 */
export function pinRank(memory) {
  if (!memory) return 1;
  if (isPermanent(memory)) return 2;
  const tags = Array.isArray(memory.tags) ? memory.tags.map((t) => String(t || '').toLowerCase()) : [];
  if (tags.includes('pinned')) return 2;
  const category = String(memory.category || '');
  if (['relationship', 'promise', 'profile'].includes(category)) return 2;
  return 1;
}

/** 私聊来源的记忆：群聊注入时必须排除。 */
export function isPrivateMemory(memory) {
  const source = memory?.source;
  if (!source || typeof source !== 'object') return false;
  if (String(source.kind || '').toLowerCase() === 'private') return true;
  return /^private:/i.test(String(source.key || ''));
}

export const SENSITIVE_INFO_PATTERN = /(密码|口令|token|密钥|私钥|身份证|银行卡|卡号|验证码|手机号|住址|家庭地址|api[_-]?key|secret)/i;

export function hasSensitiveInfo(text) {
  return SENSITIVE_INFO_PATTERN.test(String(text || ''));
}

/** 业务/输入错误。MCP 层会把 message 原样回给模型并标 isError。 */
export class MemoryError extends Error {
  constructor(message, code = 'BAD_INPUT') {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function round4(value) {
  return Math.round(clamp(value, 0, 1) * 10000) / 10000;
}

export function round2(value) {
  return Math.round(clamp(value, 0, 1) * 100) / 100;
}

export function sha1(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex');
}

/** 归一化：去首尾空白、压缩所有空白为单个空格（保留中文标点，不转半角）。 */
export function normalizeText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 实体名归一化：在 normalizeText 基础上去掉结尾的常见语气/标点并小写用于比较。 */
export function normalizeName(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[，。！？、；：,.!?;:'"“”‘’（）()【】\[\]…~～·]+$/g, '')
    .trim();
}

/** 去掉全部空白与标点，用于 bigram 相似度 / 子串匹配。 */
export function compactText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]…~～·<>《》「」『』—\-_/\\|@#$%^&*+=`]+/g, '');
}

// ---------------------------------------------------------------------------
// ID（§3：确定性 ID，便于跨进程/重复导入幂等）
// ---------------------------------------------------------------------------

export function memoryId(normalizedTextValue, sourceKey = 'manual') {
  return `mem_${sha1(`${normalizeText(normalizedTextValue)}|${normalizeText(sourceKey) || 'manual'}`).slice(0, 12)}`;
}

export function entityId(type, normalizedName) {
  return `ent_${sha1(`${type}|${normalizeName(normalizedName)}`).slice(0, 12)}`;
}

export function relationId(from, relation, to) {
  return `rel_${sha1(`${from}|${relation}|${to}`).slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// 分词 / 关键词 / 相关度 / 去重
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '咱', '俺',
  '在', '有', '和', '与', '及', '或', '就', '都', '也', '还', '又', '很', '太', '更', '最',
  '这', '那', '个', '不', '没', '要', '会', '能', '可', '把', '被', '让', '给', '对', '从', '到',
  '但', '而', '所以', '因为', '然后', '如果', '虽然', '就是', '不是', '还是', '已经', '现在',
  '今天', '昨天', '明天', '一个', '什么', '怎么', '这个', '那个', '可以', '我们', '你们', '他们',
  '吗', '呢', '吧', '啊', '哦', '嗯', '呀', '哈', '嘛', '啦', '着', '过', '得', '地',
]);

let segmenter = null;
function getSegmenter() {
  if (segmenter !== null) return segmenter;
  try {
    segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  } catch {
    segmenter = false;
  }
  return segmenter;
}

/**
 * 用 Intl.Segmenter 分词（中文按词、英文按词），失败时退化为按空白切。
 * @returns {string[]} 保留原文大小写，去重后按出现顺序返回
 */
export function segmentWords(text, { limit = 200, dropStopwords = false } = {}) {
  const input = normalizeText(text);
  if (!input) return [];
  const words = [];
  const seen = new Set();
  const push = (raw) => {
    const word = String(raw ?? '').trim();
    if (!word) return;
    const key = word.toLowerCase();
    if (seen.has(key)) return;
    if (dropStopwords && STOPWORDS.has(key)) return;
    seen.add(key);
    words.push(word);
  };
  const seg = getSegmenter();
  if (seg) {
    try {
      for (const part of seg.segment(input)) {
        if (!part.isWordLike) continue;
        push(part.segment);
        if (words.length >= limit) break;
      }
    } catch {
      /* fallthrough */
    }
  }
  if (!words.length) {
    for (const part of input.split(/\s+/)) {
      push(part);
      if (words.length >= limit) break;
    }
  }
  return words;
}

/** 关键词提取（remember 未显式给 keywords 时使用）：中文 2+ 字词、英文 3+ 字母。 */
export function extractKeywords(text, { limit = 8 } = {}) {
  const out = [];
  for (const word of segmentWords(text, { limit: 120, dropStopwords: true })) {
    if (/^[a-z0-9]+$/i.test(word)) {
      if (word.length < 3) continue;
    } else if (word.length < 2) {
      continue;
    }
    if (word.length > 20) continue;
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

export function bigrams(text) {
  const compact = compactText(text);
  if (!compact) return new Set();
  if (compact.length === 1) return new Set([compact]);
  const grams = new Set();
  for (let i = 0; i < compact.length - 1; i += 1) grams.add(compact.slice(i, i + 2));
  return grams;
}

/** bigram Jaccard 相似度（§6.2 dedupe 阈值 0.82）。 */
export function bigramSimilarity(a, b) {
  const left = compactText(a);
  const right = compactText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const ga = bigrams(left);
  const gb = bigrams(right);
  if (!ga.size || !gb.size) return 0;
  let intersection = 0;
  for (const gram of ga) if (gb.has(gram)) intersection += 1;
  return intersection / (ga.size + gb.size - intersection);
}

/** 文本相似度：bigram Jaccard 为基础，整串包含时给高一点的分数（避免短文本误判）。 */
export function textSimilarity(a, b) {
  const left = compactText(a);
  const right = compactText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const base = bigramSimilarity(left, right);
  if (left.includes(right) || right.includes(left)) {
    const shorter = Math.min(left.length, right.length);
    const longer = Math.max(left.length, right.length);
    // 覆盖比例越大越接近 1；短文本被长文本包含时也比纯 bigram 更可信。
    return Math.max(base, 0.82 + 0.18 * (shorter / longer));
  }
  return base;
}

/** 文本 token 集合：分词 + 相邻 bigram，用于搜索相关度。 */
export function textTokens(text) {
  const tokens = new Set();
  const input = normalizeText(text);
  if (!input) return tokens;
  for (const word of segmentWords(input, { limit: 240 })) tokens.add(word.toLowerCase());
  const compact = compactText(input);
  for (let i = 0; i < compact.length - 1; i += 1) tokens.add(compact.slice(i, i + 2));
  return tokens;
}

/**
 * 文本相关度（0~1）：query 分词 + 原文整串，在 title/text/keywords 里的命中比例。
 * query 为空时按契约返回 0（调用方只按强度/新近度排）。
 */
export function textRelevance(query, memory) {
  const q = normalizeText(query);
  if (!q) return 0;
  const tokens = new Set();
  for (const word of segmentWords(q, { limit: 40 })) tokens.add(word.toLowerCase());
  tokens.add(q.toLowerCase());
  if (!tokens.size) return 0;
  const haySource = [memory?.title, memory?.text, ...(Array.isArray(memory?.keywords) ? memory.keywords : [])]
    .filter(Boolean)
    .join(' ');
  const hayLower = normalizeText(haySource).toLowerCase();
  const hayTokens = textTokens(haySource);
  let hits = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (token.length > 1 && hayLower.includes(token)) hits += 1;
    else if (hayTokens.has(token)) hits += 1;
  }
  const exact = clamp(hits / tokens.size, 0, 1);
  if (exact >= 0.5) return exact;
  // 三路召回之「模糊/相近」路（2026-10-28）：线索只给一半（子串/改写）也能召回；
  // 用 bigram 相似度代替离线不可用的向量模型，避免为了语义召回引入外部依赖。
  const fuzzy = textSimilarity(q, haySource);
  const fuzzyBoost = fuzzy >= 0.2 ? clamp(0.55 * fuzzy + 0.2, 0, 1) : 0;
  return clamp(Math.max(exact, fuzzyBoost), 0, 1);
}

export function layerWeight(layer) {
  return layer === 'long' ? 1 : 0.6;
}

/** 新近度：7 天内线性 1→0（基于 lastActivatedAt，缺省回退 updatedAt/createdAt）。 */
export function recencyScore(lastActivatedAt, now = Date.now()) {
  const at = Number(lastActivatedAt);
  if (!Number.isFinite(at) || at <= 0) return 0;
  const age = Math.max(0, Number(now) - at);
  return clamp(1 - age / (7 * DAY_MS), 0, 1);
}

/** §3 排序公式：0.40 相关度 + 0.20 强度 + 0.15 层级 + 0.15 实体命中 + 0.10 新近度。 */
export function scoreMemory(memory, { query = '', now = Date.now(), entityHit = 0 } = {}) {
  const relevance = query ? textRelevance(query, memory) : 0;
  const strength = Number.isFinite(Number(memory?.strength)) ? clamp(memory.strength, 0, 1) : computeStrength(memory, now);
  return (
    0.4 * relevance +
    0.2 * strength +
    0.15 * layerWeight(memory?.layer) +
    0.15 * clamp(entityHit, 0, 1) +
    0.1 * recencyScore(memory?.lastActivatedAt ?? memory?.updatedAt ?? memory?.createdAt, now)
  );
}

// ---------------------------------------------------------------------------
// v1.3 神经式记忆（2026-10-28）：扩散激活 / Hebbian 共激活 / 冲突检测 / 零 LLM 抽取
//
// 借鉴 NeuralMemory 的思路，但保持本仓库「零外部依赖、纯函数、可离线」：
// - 召回不只看字面相似度，还从「查询命中的记忆/实体」出发沿图扩散若干跳（深度分档）；
// - 两条记忆被同一次 recall 命中时，它们之间的突触权重 +1（Hebbian：一起激发就连接）；
// - 新决策与旧记忆冲突时，旧记忆标记 superseded 降权，不再默认参与召回；
// - 用正则+词典从一段文本里抽取决策/承诺/偏好/错误/待办，替代 LLM 摘要（ingest）。
// ---------------------------------------------------------------------------

/** 4 档深度：数值越大越慢、扩散跳数越多（GET 侧只读，无副作用）。 */
export const DEPTH_PROFILES = Object.freeze([
  { depth: 0, name: 'Instant', latency: '<10ms', hops: 0, activationWeight: 0, label: '即时：快速事实/最近上下文' },
  { depth: 1, name: 'Context', latency: '~50ms', hops: 1, activationWeight: 0.3, label: '默认：标准召回（1 跳扩散）' },
  { depth: 2, name: 'Habit', latency: '~200ms', hops: 2, activationWeight: 0.45, label: '工作流模式识别（2 跳扩散）' },
  { depth: 3, name: 'Deep', latency: '~500ms', hops: 3, activationWeight: 0.6, label: '跨域关联/因果链追踪（3 跳扩散）' },
]);

export function normalizeDepth(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return clamp(Math.round(Number(fallback) || 1), 0, 3);
  return clamp(Math.round(n), 0, 3);
}

export function depthProfile(depth) {
  return DEPTH_PROFILES[normalizeDepth(depth, 1)];
}

/** Hebbian 突触强度：共同激活次数越多越强，饱和于 0.9（避免单条记忆统治扩散）。 */
export function hebbianWeight(coactivations) {
  const count = Math.max(0, Number(coactivations) || 0);
  return clamp(0.25 + 0.15 * Math.log2(1 + count), 0.25, 0.9);
}

/**
 * 扩散激活（纯函数，只读 brain）。
 * 从种子记忆/实体出发，沿「记忆↔实体」「记忆↔记忆共激活突触」「实体↔实体关系」三类边扩散，
 * 每跳衰减 decay，取到达每个节点的最大激活值。
 * @param {object} brain
 * @param {{memoryIds?: string[], entityIds?: string[]}} seeds
 * @param {{hops?: number, decay?: number, maxNodes?: number}} [options]
 * @returns {{memories: Record<string, number>, entities: Record<string, number>, profile: object}}
 */
export function spreadingActivation(brain, seeds = {}, { hops = 1, decay = 0.5, maxNodes = 8000 } = {}) {
  const profiles = depthProfile(hops);
  const limit = Math.max(1, Math.min(20, Number(hops) || profiles.hops));
  const decayPerHop = clamp(Number(decay) || 0.5, 0.05, 0.95);
  const memories = brain?.memories && typeof brain.memories === 'object' ? brain.memories : {};
  const entities = brain?.entities && typeof brain.entities === 'object' ? brain.entities : {};
  const relations = Array.isArray(brain?.relations) ? brain.relations : [];
  const synapses = Array.isArray(brain?.synapses) ? brain.synapses : [];

  const memByEntity = new Map();
  for (const memory of Object.values(memories)) {
    if (!memory) continue;
    for (const entityRef of Array.isArray(memory.entityIds) ? memory.entityIds : []) {
      if (!memByEntity.has(entityRef)) memByEntity.set(entityRef, []);
      memByEntity.get(entityRef).push(memory.id);
    }
  }
  const relAdj = new Map();
  for (const relation of relations) {
    if (!relation || !relation.from || !relation.to) continue;
    if (!relAdj.has(relation.from)) relAdj.set(relation.from, []);
    relAdj.get(relation.from).push({ to: relation.to, weight: clamp(Number(relation.weight) || 1, 0, 1) });
  }
  const synAdj = new Map();
  for (const synapse of synapses) {
    if (!synapse || !synapse.from || !synapse.to) continue;
    const weight = clamp(Number(synapse.weight) || hebbianWeight(synapse.coactivations), 0.05, 1);
    if (!synAdj.has(synapse.from)) synAdj.set(synapse.from, []);
    if (!synAdj.has(synapse.to)) synAdj.set(synapse.to, []);
    synAdj.get(synapse.from).push({ to: synapse.to, weight });
    synAdj.get(synapse.to).push({ to: synapse.from, weight });
  }

  const activation = new Map();
  const entityActivation = new Map();
  const queue = [];
  const pushMemory = (id, score) => {
    if (!id || !memories[id]) return;
    const prev = activation.get(id) || 0;
    if (score <= prev + 1e-6) return;
    activation.set(id, score);
    queue.push({ kind: 'memory', id, score, level: 0 });
  };
  const pushEntity = (id, score) => {
    if (!id || !entities[id]) return;
    const prev = entityActivation.get(id) || 0;
    if (score <= prev + 1e-6) return;
    entityActivation.set(id, score);
    queue.push({ kind: 'entity', id, score, level: 0 });
  };
  for (const id of Array.isArray(seeds.memoryIds) ? seeds.memoryIds : []) pushMemory(id, 1);
  for (const id of Array.isArray(seeds.entityIds) ? seeds.entityIds : []) pushEntity(id, 1);

  let visited = 0;
  while (queue.length && visited < maxNodes) {
    const node = queue.shift();
    visited += 1;
    if (node.level >= limit) continue;
    const childBase = node.score * decayPerHop;
    if (node.kind === 'memory') {
      const memory = memories[node.id];
      for (const entityRef of Array.isArray(memory.entityIds) ? memory.entityIds : []) {
        const prev = entityActivation.get(entityRef) || 0;
        if (childBase > prev + 1e-6 && entities[entityRef]) {
          entityActivation.set(entityRef, childBase);
          queue.push({ kind: 'entity', id: entityRef, score: childBase, level: node.level + 1 });
        }
      }
      for (const edge of synAdj.get(node.id) || []) {
        const score = node.score * decayPerHop * edge.weight;
        if (score > (activation.get(edge.to) || 0) + 1e-6) {
          activation.set(edge.to, score);
          queue.push({ kind: 'memory', id: edge.to, score, level: node.level + 1 });
        }
      }
    } else {
      for (const memoryRef of memByEntity.get(node.id) || []) {
        if (childBase > (activation.get(memoryRef) || 0) + 1e-6) {
          activation.set(memoryRef, childBase);
          queue.push({ kind: 'memory', id: memoryRef, score: childBase, level: node.level + 1 });
        }
      }
      for (const edge of relAdj.get(node.id) || []) {
        const score = node.score * decayPerHop * Math.max(0.2, edge.weight);
        if (score > (entityActivation.get(edge.to) || 0) + 1e-6 && entities[edge.to]) {
          entityActivation.set(edge.to, score);
          queue.push({ kind: 'entity', id: edge.to, score, level: node.level + 1 });
        }
      }
    }
  }
  return {
    memories: Object.fromEntries([...activation.entries()].map(([id, score]) => [id, round4(score)])),
    entities: Object.fromEntries([...entityActivation.entries()].map(([id, score]) => [id, round4(score)])),
    profile: profiles,
  };
}

// 零 LLM 抽取规则：中文正则 + 分类词表。宁可少抽，也不要把寒暄/问句抽成记忆。
const AUTO_EXTRACT_RULES = Object.freeze([
  { kind: 'decision', category: 'fact', tag: 'decision', weight: 3, pattern: /(决定|约定|说好|以后|从此|改成|改为|改用|换成|采用|不再|取消|废弃|最终|定稿)/ },
  { kind: 'promise', category: 'promise', tag: 'promise', weight: 3, pattern: /(答应|保证|承诺|必须|不许|别忘|一定会)/ },
  { kind: 'preference', category: 'preference', tag: 'preference', weight: 2, pattern: /(喜欢|不喜欢|讨厌|偏好|习惯|爱吃|爱听)/ },
  { kind: 'error', category: 'event', tag: 'bugfix', weight: 3, pattern: /(报错|错误|失败|异常|崩溃|闪退|无法|不能用|坏了|bug)/i },
  { kind: 'todo', category: 'event', tag: 'todo', weight: 2, pattern: /(待办|要做|还得|需要做|记得去|TODO)/i },
]);

function sentenceChunks(text) {
  const normalized = normalizeText(text);
  const parts = normalized
    .split(/[。！？!?；;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!parts.length && normalized) parts.push(normalized);
  // 单句过长时按逗号再切，避免把整段都抽成一条。
  const chunks = [];
  for (const part of parts) {
    if (part.length <= 120) chunks.push(part);
    else chunks.push(...part.split(/[，,]/).map((item) => item.trim()).filter((item) => item.length >= 6));
  }
  return chunks;
}

/**
 * 零 LLM 自动抽取：从一段文本里找「值得入库」的句子（决策/承诺/偏好/错误/待办）。
 * @returns {Array<{text: string, category: string, tags: string[], kind: string, confidence: number}>}
 */
export function extractMemoryCandidates(text, { max = 6 } = {}) {
  const candidates = [];
  const seen = new Set();
  for (const sentence of sentenceChunks(text)) {
    if (sentence.length < 6 || /^[?？]+$/.test(sentence)) continue;
    const isQuestion = /[?？]$/.test(sentence) && !/(决定|约定|答应|保证|必须|不许)/.test(sentence);
    const compact = compactText(sentence);
    if (!compact || seen.has(compact)) continue;
    let best = null;
    for (const rule of AUTO_EXTRACT_RULES) {
      if (isQuestion && rule.kind !== 'error' && rule.kind !== 'todo') continue;
      if (!rule.pattern.test(sentence)) continue;
      if (!best || rule.weight > best.weight) best = rule;
    }
    if (!best) continue;
    seen.add(compact);
    candidates.push({
      text: sentence.slice(0, 500),
      category: best.category,
      tags: ['auto', best.tag],
      kind: best.kind,
      confidence: round2(clamp(best.weight / 3, 0, 1)),
    });
    if (candidates.length >= Math.max(1, Number(max) || 6)) break;
  }
  return candidates;
}

// 新信息里出现这些「变更动词」才可能取代旧记忆；否则只是补充，不误杀。
const CONFLICT_CHANGE_MARKERS = /(改成|改为|改用|换成|换为|不再|取消|废弃|替代|取代|更新为|改回|撤销|推翻|最终|定稿|以后用)/;

/**
 * 启发式矛盾检测（纯函数，无 LLM）：新记忆含变更动词 + 与旧记忆有主题重叠 ⇒ 旧记忆应被降权。
 * 只做「新压旧」，不自动删除；精度优先，宁可漏检不误杀。
 * @returns {{conflict: boolean, kind: 'supersede'|null, reason: string, score: number}}
 */
export function detectContradiction(prev, next) {
  const empty = { conflict: false, kind: null, reason: '', score: 0 };
  if (!prev || !next) return empty;
  if (!['active', 'fading'].includes(prev.status)) return empty;
  if (isPermanent(prev)) return empty;
  const nextText = normalizeText(`${next.title || ''} ${next.text || ''}`);
  if (!CONFLICT_CHANGE_MARKERS.test(nextText)) return empty;
  const prevText = normalizeText(`${prev.title || ''} ${prev.text || ''}`);
  const prevTokens = new Set([...textTokens(prevText)].filter((token) => token.length >= 2));
  const nextTokens = [...textTokens(nextText)].filter((token) => token.length >= 2);
  const shared = nextTokens.filter((token) => prevTokens.has(token));
  const similarity = textSimilarity(prevText, nextText);
  const prevEntities = new Set(Array.isArray(prev.entityIds) ? prev.entityIds : []);
  const sharedEntities = (Array.isArray(next.entityIds) ? next.entityIds : []).filter((id) => prevEntities.has(id)).length;
  if (!shared.length && similarity < 0.45 && sharedEntities === 0) return empty;
  const score = round2(
    clamp(0.4 * clamp(shared.length / 3, 0, 1) + 0.4 * similarity + 0.2 * clamp(sharedEntities, 0, 1), 0, 1)
  );
  return {
    conflict: true,
    kind: 'supersede',
    reason: `新信息含变更词，且主题重叠（共享词 ${shared.slice(0, 4).join('/') || '无'}，相似度 ${round2(similarity)}${sharedEntities ? `，共同实体 ${sharedEntities}` : ''}）`,
    score,
  };
}

// ---------------------------------------------------------------------------
// 衰减 / 状态机（§3 公式，测试会断言）
// ---------------------------------------------------------------------------

export function elapsedDays(memory, now = Date.now()) {
  const last = Number(memory?.lastActivatedAt ?? memory?.createdAt ?? 0);
  if (!Number.isFinite(last) || last <= 0) return 0;
  return Math.max(0, (Number(now) - last) / DAY_MS);
}

/**
 * 遗忘曲线：默认线性（好预测归档时间）；`decayCurve: 'ebbinghaus'` 时用艾宾浩斯指数衰减。
 * 线性：strength = clamp(base - elapsed/decayDays, 0, 1)
 * 艾宾浩斯：strength = base * e^{-elapsed / (decayDays/3)}（decayDays 处约剩 5%，与线性归零点对齐）
 */
export function computeStrength(memory, now = Date.now()) {
  if (!memory) return 0;
  if (isPermanent(memory) || isDiaryMemory(memory)) return 1;
  const baseDecayDays = Math.max(1, Number(memory.decayDays) || DEFAULT_CONFIG.decayDaysShort);
  // 关键度（2026-10-31）：核心条目衰减慢 6 倍、重要慢 2 倍，普通的照旧。
  // 只看记忆本身的硬指标，所以同一件事不会因为当时心情不同就忽轻忽重。
  const tier = salienceTier(salienceScore(memory));
  const decayDays = baseDecayDays * (SALIENCE_TIERS[tier]?.decayFactor || 1);
  const base = clamp(Number(memory.baseStrength ?? memory.strength ?? 1), 0, 1);
  const curve = String(memory.decayCurve || DEFAULT_CONFIG.decayCurve || 'linear').toLowerCase();
  if (curve === 'ebbinghaus') {
    return round4(clamp(base * Math.exp(-elapsedDays(memory, now) / (decayDays / 3)), 0, 1));
  }
  return round4(clamp(base - elapsedDays(memory, now) / decayDays, 0, 1));
}

/** 记忆保持率 R = e^{-t/S}（用于展示艾宾浩斯曲线；S=decayDays/3 与指数衰减一致）。 */
export function retentionOf(memory, now = Date.now()) {
  if (!memory) return 0;
  if (isPermanent(memory) || isDiaryMemory(memory)) return 1;
  const decayDays = Math.max(1, Number(memory.decayDays) || DEFAULT_CONFIG.decayDaysShort);
  return round4(clamp(Math.exp(-elapsedDays(memory, now) / (decayDays / 3)), 0, 1));
}

/**
 * 用进废退的三层记忆（NeuralMemory 的 Short-term / Working / Episodic）：
 * - working：最近 2 小时内被激活过（当前会话/刚发生）
 * - short-term：短期层且 7 天内的新鲜记忆
 * - episodic：事件/情境类记忆（category=event 或日记）
 * - long-term：其余长期事实/偏好
 */
export const MEMORY_TIERS = Object.freeze(['working', 'short-term', 'episodic', 'long-term']);

export function memoryTier(memory, now = Date.now()) {
  if (!memory) return 'long-term';
  // 情境/日记记忆优先归 episodic（即使刚写完，也属于「情境记忆」而不是当前工作记忆）。
  if (isDiaryMemory(memory) || memory.category === 'event') return 'episodic';
  const last = Number(memory.lastActivatedAt || memory.updatedAt || memory.createdAt || 0);
  const ageHours = last ? (Number(now) - last) / 3_600_000 : 0;
  if (memory.status === 'active' && ageHours >= 0 && ageHours <= 2) return 'working';
  const ageDays = elapsedDays(memory, now);
  if (memory.layer === 'short' && ageDays <= 7) return 'short-term';
  return 'long-term';
}

/**
 * 深度建议（depth 0-3）：根据问题里的多跳/因果/跨域线索给一个默认档位。
 * 只是建议值，调用方仍可显式传 depth。
 */
export function suggestedDepth(text = '') {
  const value = String(text || '').trim();
  if (!value) return 1;
  if (/(所有|全部|历史|跨|一直|从头|梳理|全景|长线)/.test(value)) return 3;
  if (/(为什么|原因|怎么|怎么改|之前|那次|后来|关联|影响|因果|借鉴|结合|对比|哪几次)/.test(value) || value.length > 40) return 2;
  return 1;
}

export function isPermanent(memory) {
  return Number(memory?.protection) >= PERMANENT_PROTECTION;
}

/**
 * 日记类记忆（`tags` 含 `diary`，不区分大小写）。
 * 2026-10-28：日记单独归档到 vault 的 `日记/`，并且不参与衰减/清理（见 materializeMemory）。
 */
export function isDiaryMemory(memory) {
  const tags = memory?.tags;
  return Array.isArray(tags) && tags.some((tag) => String(tag ?? '').trim().toLowerCase() === 'diary');
}

export function statusForStrength(strength, config = DEFAULT_CONFIG) {
  const fade = Number(config?.fadeThreshold ?? FADE_THRESHOLD);
  const forget = Number(config?.forgetThreshold ?? FORGET_THRESHOLD);
  if (strength <= forget) return 'faded';
  if (strength < fade) return 'fading';
  return 'active';
}

/**
 * 把一条记忆物化到 `now`：重算 strength、推进 fading/faded 状态机。
 * 幂等：已落盘的 fadingSince / purgeAfter 不会被反复往后推（否则永远清不掉）。
 * @returns {boolean} 是否有字段变化
 */
export function materializeMemory(memory, now = Date.now(), config = DEFAULT_CONFIG) {
  if (!memory || typeof memory !== 'object') return false;
  const before = `${memory.strength}|${memory.status}|${memory.fadingSince}|${memory.purgeAfter}|${memory.permanent}`;
  // 用户手动归档的记忆不再随时间变化（vault 不展示，等待 purge/forget）。
  if (memory.status === 'archived') {
    memory.permanent = isPermanent(memory);
    if (memory.permanent) {
      memory.strength = 1;
      memory.status = 'active';
    }
    const after = `${memory.strength}|${memory.status}|${memory.fadingSince}|${memory.purgeAfter}|${memory.permanent}`;
    return after !== before;
  }
  // 日记：单独归档、不参与衰减，也不会被清理（2026-10-28）。
  if (isDiaryMemory(memory)) {
    memory.permanent = isPermanent(memory);
    memory.strength = 1;
    memory.status = 'active';
    memory.fadingSince = null;
    memory.purgeAfter = null;
    const after = `${memory.strength}|${memory.status}|${memory.fadingSince}|${memory.purgeAfter}|${memory.permanent}`;
    return after !== before;
  }
  // v1.3：被新决策取代/降权的记忆冻结在 superseded，不再随时间衰减，也不参与默认召回。
  if (memory.status === 'superseded') {
    memory.permanent = isPermanent(memory);
    memory.fadingSince = null;
    memory.purgeAfter = null;
    return false;
  }
  const permanent = isPermanent(memory);
  memory.permanent = permanent;
  if (permanent) {
    // §3：protection=1 → 永久，跳过衰减/遗忘，status 恒 active。
    memory.strength = 1;
    memory.status = 'active';
    memory.fadingSince = null;
    memory.purgeAfter = null;
  } else {
    const strength = computeStrength(memory, now);
    const status = statusForStrength(strength, config);
    memory.strength = strength;
    memory.status = status;
    const purgeGraceDays = Math.max(0, Number(config?.purgeGraceDays ?? FADING_PURGE_GRACE_DAYS));
    if (status === 'faded') {
      if (!memory.fadingSince) memory.fadingSince = Number(now);
      if (!memory.purgeAfter) memory.purgeAfter = Number(now) + purgeGraceDays * DAY_MS;
    } else if (status === 'fading') {
      if (!memory.fadingSince) memory.fadingSince = Number(now);
      memory.purgeAfter = null;
    } else {
      memory.fadingSince = null;
      memory.purgeAfter = null;
    }
  }
  const after = `${memory.strength}|${memory.status}|${memory.fadingSince}|${memory.purgeAfter}|${memory.permanent}`;
  return after !== before;
}

export function isPurgeDue(memory, now = Date.now()) {
  return (
    Boolean(memory) &&
    !isPermanent(memory) &&
    !isDiaryMemory(memory) &&
    memory.status === 'faded' &&
    Number(memory.purgeAfter) > 0 &&
    Number(now) >= Number(memory.purgeAfter)
  );
}

/**
 * 物化整个 brain（就地修改）。
 * 2026-10-28 起：过了清理期的边缘记忆不再物理删除，而是归档（status=archived、archivedReason=decayed），
 * 保留时间线与可追溯性；真正删除只由 forget(purge) 显式触发。
 * @param {{archive?: boolean, purge?: boolean}} options archive=true（或 purge=true）时归档到期 faded 记忆并返回列表。
 * @returns {{changed: boolean, archived: Array<object>}}
 */
export function materializeBrain(brain, now = Date.now(), config = brain?.config ?? DEFAULT_CONFIG, { archive = false, purge = false } = {}) {
  const archived = [];
  const changedIds = [];
  const archiveDue = archive || purge;
  let changed = false;
  if (!brain || typeof brain !== 'object') return { changed, changedIds, archived };
  const memories = brain.memories && typeof brain.memories === 'object' ? brain.memories : {};
  for (const [id, memory] of Object.entries(memories)) {
    if (!memory) continue;
    if (archiveDue && isPurgeDue(memory, now)) {
      memory.status = 'archived';
      memory.archivedAt = Number(now);
      memory.archivedReason = 'decayed';
      memory.permanent = isPermanent(memory);
      archived.push({ id, title: memory.title ?? '', layer: memory.layer ?? null, strength: memory.strength ?? 0, reason: 'decayed' });
      changedIds.push(id);
      changed = true;
      continue;
    }
    if (materializeMemory(memory, now, config)) {
      changedIds.push(id);
      changed = true;
    }
  }
  return { changed, changedIds, archived };
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const CONFIG_NUMBER_RULES = {
  decayDaysLong: { min: 1, max: 36500 },
  decayDaysShort: { min: 1, max: 36500 },
  protectionLine: { min: 0, max: 1 },
  fadeThreshold: { min: 0.001, max: 1 },
  forgetThreshold: { min: 0, max: 1 },
  purgeGraceDays: { min: 0, max: 3650 },
  maxMemories: { min: 1, max: 1_000_000 },
  maxMemoriesLong: { min: 1, max: 1_000_000 },
  maxMemoriesShort: { min: 1, max: 1_000_000 },
  progressKeep: { min: 1, max: 50 },
  progressMergeMin: { min: 2, max: 100 },
  maxMemoriesPerEntityLink: { min: 1, max: 10_000 },
  lockTimeoutMs: { min: 0, max: 120_000 },
  backupKeep: { min: 1, max: 100 },
  eventLogKeepBytes: { min: 1024, max: 1_000_000_000 },
};

/** 深合并默认值 + raw 配置，非法值回退默认；未知键忽略。 */
export function normalizeConfig(raw = {}) {
  const config = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== 'object') return config;
  for (const [key, rule] of Object.entries(CONFIG_NUMBER_RULES)) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const n = Number(raw[key]);
    if (!Number.isFinite(n)) continue;
    config[key] = clamp(n, rule.min, rule.max);
  }
  if (raw.defaultLayer !== undefined && MEMORY_LAYERS.includes(raw.defaultLayer)) config.defaultLayer = raw.defaultLayer;
  if (raw.defaultCategory !== undefined && MEMORY_CATEGORIES.includes(raw.defaultCategory)) {
    config.defaultCategory = raw.defaultCategory;
  }
  if (typeof raw.vaultDir === 'string' && raw.vaultDir.trim()) config.vaultDir = raw.vaultDir.trim();
  // v1.4：遗忘曲线可选 linear（默认）/ ebbinghaus。
  if (raw.decayCurve !== undefined) {
    const curve = String(raw.decayCurve || '').toLowerCase();
    if (curve === 'linear' || curve === 'ebbinghaus') config.decayCurve = curve;
  }
  // 语义保护：fadeThreshold 必须 >= forgetThreshold，防止配置把状态机拧反。
  if (config.fadeThreshold < config.forgetThreshold) config.fadeThreshold = config.forgetThreshold;
  return config;
}

// ---------------------------------------------------------------------------
// brain 快照 / 输出投影
// ---------------------------------------------------------------------------

export function emptyBrain(now = Date.now(), config = DEFAULT_CONFIG) {
  return {
    version: MEMORY_VERSION,
    createdAt: Number(now),
    updatedAt: Number(now),
    config: { ...DEFAULT_CONFIG, ...config },
    entities: {},
    relations: [],
    // v1.3：记忆↔记忆的共激活突触（Hebbian）。
    synapses: [],
    // v1.5-lite：人格状态（精力/心情），只存状态，不写记忆。
    state: normalizePersonaState(DEFAULT_PERSONA_STATE, Number(now)),
    self: emptySelf(),
    // v1.7：情绪记录（带时间戳/过期时间；唤醒时只复读未过期的）。
    emotions: [],
    memories: {},
  };
}

export function emptyEntity({ type = 'topic', name = '', now = Date.now() } = {}, source = null) {
  return {
    id: entityId(type, name),
    type,
    name: normalizeText(name),
    aliases: [],
    tags: [],
    note: '',
    mentionCount: 1,
    firstSeenAt: Number(now),
    lastMentionedAt: Number(now),
    source: source ?? null,
    createdAt: Number(now),
    updatedAt: Number(now),
  };
}

export function emptyMemory({
  text = '',
  title = '',
  layer = 'short',
  category = 'other',
  keywords = [],
  entityIds = [],
  tags = [],
  protection = 0,
  decayDays = 30,
  decayCurve = 'linear',
  expiresAt = 0,
  source = null,
  now = Date.now(),
} = {}) {
  const normalized = normalizeText(text);
  const sourceKey = normalizeText(source?.key) || 'manual';
  return {
    id: memoryId(normalized, sourceKey),
    layer,
    category,
    title: normalizeText(title) || normalized.slice(0, 30),
    text: normalized.slice(0, 2000),
    keywords: [...keywords],
    entityIds: [...entityIds],
    tags: [...tags],
    protection: clamp(protection, 0, 1),
    permanent: Number(protection) >= PERMANENT_PROTECTION,
    strength: 1,
    baseStrength: 1,
    decayDays: Math.max(1, Number(decayDays) || DEFAULT_CONFIG.decayDaysShort),
    decayCurve: String(decayCurve || '').toLowerCase() === 'ebbinghaus' ? 'ebbinghaus' : 'linear',
    // 有效期：一次性事实（「今晚不关机」「明天早八」）到点自动失效，不靠衰减慢慢拖。
    // 0 表示不设期限，走原来的衰减逻辑。
    expiresAt: Math.max(0, Number(expiresAt) || 0),
    status: 'active',
    activationCount: 1,
    createdAt: Number(now),
    updatedAt: Number(now),
    lastActivatedAt: Number(now),
    fadingSince: null,
    purgeAfter: null,
    // v1.3：被新决策取代时写入（status=superseded、deprioritized=true），保留时间线不删除。
    supersededBy: null,
    supersededAt: null,
    deprioritized: false,
    supersedes: [],
    source: source ?? { kind: 'manual', key: 'manual', seqs: [] },
    recallLog: [],
  };
}

const MEMORY_PUBLIC_FIELDS = [
  'id',
  'layer',
  'category',
  'title',
  'text',
  'keywords',
  'entityIds',
  'tags',
  'protection',
  'permanent',
  'strength',
  'baseStrength',
  'decayDays',
  'decayCurve',
  'status',
  'activationCount',
  'createdAt',
  'updatedAt',
  'lastActivatedAt',
  'fadingSince',
  'purgeAfter',
  'archivedAt',
  'archivedReason',
  'supersededBy',
  'supersededAt',
  'deprioritized',
  'supersedes',
  'expiresAt',
  'source',
  'recallLog',
];

/** 输出投影：只带契约字段 + 浅拷贝，避免 MCP/CLI 直接把内部对象交出去。 */
export function publicMemory(memory, { includeText = true, includeRecallLog = false } = {}) {
  if (!memory || typeof memory !== 'object') return null;
  const out = {};
  for (const field of MEMORY_PUBLIC_FIELDS) {
    if (field === 'text' && !includeText) continue;
    if (field === 'recallLog' && !includeRecallLog) continue;
    if (field === 'recallLog') {
      out.recallLog = Array.isArray(memory.recallLog) ? memory.recallLog.slice(-10) : [];
      continue;
    }
    if (field === 'source' || field === 'keywords' || field === 'entityIds' || field === 'tags' || field === 'supersedes') {
      out[field] = Array.isArray(memory[field]) ? [...memory[field]] : memory[field] && typeof memory[field] === 'object' ? { ...memory[field] } : memory[field] ?? null;
      continue;
    }
    out[field] = memory[field] ?? null;
  }
  if (typeof memory.note === 'string' && memory.note) out.note = memory.note;
  // v1.4：用进废退分层与保持率（只用于展示/排序提示，不写回记忆本体）。
  out.tier = memoryTier(memory);
  out.retention = retentionOf(memory);
  return out;
}

export function publicEntity(entity) {
  if (!entity || typeof entity !== 'object') return null;
  return {
    id: entity.id,
    type: entity.type,
    name: entity.name,
    aliases: Array.isArray(entity.aliases) ? [...entity.aliases] : [],
    tags: Array.isArray(entity.tags) ? [...entity.tags] : [],
    note: entity.note ?? '',
    mentionCount: Number(entity.mentionCount) || 0,
    firstSeenAt: entity.firstSeenAt ?? null,
    lastMentionedAt: entity.lastMentionedAt ?? null,
    source: entity.source ?? null,
    createdAt: entity.createdAt ?? null,
    updatedAt: entity.updatedAt ?? null,
  };
}

export function publicRelation(relation) {
  if (!relation || typeof relation !== 'object') return null;
  return {
    id: relation.id,
    from: relation.from,
    to: relation.to,
    relation: relation.relation,
    weight: Number(relation.weight) || 1,
    note: relation.note ?? '',
    source: relation.source ?? null,
    createdAt: relation.createdAt ?? null,
    updatedAt: relation.updatedAt ?? null,
  };
}

/** 供 CLI/测试做结构自检：确保载入的 brain 形状可用（不抛异常）。 */
export /** v1.7：情绪记录归一化（情绪带时间戳/过期时间，超过 24h 不再复读）。 */
function normalizeEmotions(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const label = normalizeText(item.label);
    if (!label) continue;
    const at = Number(item.at) || 0;
    if (!at) continue;
    out.push({
      id: String(item.id || `emo_${sha1(`${label}|${at}`).slice(0, 12)}`),
      label: label.slice(0, 20),
      intensity: clamp(Number(item.intensity), 0, 1),
      at,
      expiresAt: Number(item.expiresAt) || at + 24 * 3600 * 1000,
      source: String(item.source || ''),
      note: normalizeText(item.note).slice(0, 300),
    });
    if (out.length >= 200) break;
  }
  return out;
}

export function normalizeBrainShape(brain, { now = Date.now(), config = {} } = {}) {
  const raw = brain && typeof brain === 'object' && !Array.isArray(brain) ? brain : {};
  const out = {
    version: Number(raw.version) || MEMORY_VERSION,
    createdAt: Number(raw.createdAt) || Number(now),
    updatedAt: Number(raw.updatedAt) || Number(now),
    config: normalizeConfig({ ...DEFAULT_CONFIG, ...(raw.config && typeof raw.config === 'object' ? raw.config : {}), ...config }),
    entities: {},
    relations: [],
    synapses: [],
    memories: {},
    state: normalizePersonaState(raw.state, Number(now)),
    self: normalizeSelf(raw.self),
    emotions: normalizeEmotions(raw.emotions),
  };
  if (raw.entities && typeof raw.entities === 'object' && !Array.isArray(raw.entities)) {
    for (const [id, entity] of Object.entries(raw.entities)) {
      if (!entity || typeof entity !== 'object') continue;
      const type = ENTITY_TYPES.includes(entity.type) ? entity.type : 'topic';
      const name = normalizeText(entity.name);
      if (!name) continue;
      out.entities[id] = {
        id,
        type,
        name,
        aliases: Array.isArray(entity.aliases) ? entity.aliases.map(normalizeText).filter(Boolean) : [],
        tags: Array.isArray(entity.tags) ? entity.tags.map(normalizeText).filter(Boolean) : [],
        note: typeof entity.note === 'string' ? entity.note : '',
        mentionCount: Number(entity.mentionCount) || 1,
        firstSeenAt: Number(entity.firstSeenAt) || Number(now),
        lastMentionedAt: Number(entity.lastMentionedAt) || Number(now),
        source: entity.source && typeof entity.source === 'object' ? entity.source : null,
        createdAt: Number(entity.createdAt) || Number(now),
        updatedAt: Number(entity.updatedAt) || Number(now),
      };
    }
  }
  if (Array.isArray(raw.relations)) {
    for (const relation of raw.relations) {
      if (!relation || typeof relation !== 'object') continue;
      const from = String(relation.from ?? '');
      const to = String(relation.to ?? '');
      const type = normalizeRelationType(relation.relation);
      if (!from || !to) continue;
      out.relations.push({
        id: String(relation.id || relationId(from, type, to)),
        from,
        to,
        relation: type,
        weight: Number(relation.weight) || 1,
        note: typeof relation.note === 'string' ? relation.note : '',
        source: relation.source && typeof relation.source === 'object' ? relation.source : null,
        createdAt: Number(relation.createdAt) || Number(now),
        updatedAt: Number(relation.updatedAt) || Number(now),
      });
    }
  }
  if (raw.memories && typeof raw.memories === 'object' && !Array.isArray(raw.memories)) {
    for (const [id, memory] of Object.entries(raw.memories)) {
      if (!memory || typeof memory !== 'object') continue;
      const text = normalizeText(memory.text);
      if (!text) continue;
      const layer = MEMORY_LAYERS.includes(memory.layer) ? memory.layer : 'short';
      const category = MEMORY_CATEGORIES.includes(memory.category) ? memory.category : 'other';
      const protection = clamp(Number(memory.protection ?? 0), 0, 1);
      const createdAt = Number(memory.createdAt) || Number(now);
      const lastActivatedAt = Number(memory.lastActivatedAt) || createdAt;
      out.memories[id] = {
        id,
        layer,
        category,
        title: normalizeText(memory.title) || text.slice(0, 30),
        text: text.slice(0, 2000),
        keywords: Array.isArray(memory.keywords) ? memory.keywords.map(normalizeText).filter(Boolean).slice(0, 20) : [],
        entityIds: Array.isArray(memory.entityIds) ? memory.entityIds.map(String).filter(Boolean).slice(0, DEFAULT_CONFIG.maxMemoriesPerEntityLink) : [],
        tags: Array.isArray(memory.tags) ? memory.tags.map(normalizeText).filter(Boolean) : [],
        protection,
        permanent: protection >= PERMANENT_PROTECTION,
        strength: clamp(Number(memory.strength ?? 1), 0, 1),
        baseStrength: clamp(Number(memory.baseStrength ?? 1), 0, 1),
        decayDays: Math.max(1, Number(memory.decayDays) || DEFAULT_CONFIG.decayDaysShort),
        decayCurve: String(memory.decayCurve || DEFAULT_CONFIG.decayCurve || 'linear').toLowerCase() === 'ebbinghaus' ? 'ebbinghaus' : 'linear',
        status: MEMORY_STATUSES.includes(memory.status) ? memory.status : 'active',
        activationCount: Number(memory.activationCount) || 1,
        createdAt,
        updatedAt: Number(memory.updatedAt) || createdAt,
        lastActivatedAt,
        fadingSince: memory.fadingSince ? Number(memory.fadingSince) : null,
        purgeAfter: memory.purgeAfter ? Number(memory.purgeAfter) : null,
        source: memory.source && typeof memory.source === 'object' ? { ...memory.source } : { kind: 'manual', key: 'manual', seqs: [] },
        // 有效期跨进程保留；老数据没有这个字段就是 0（不限期）。
        expiresAt: Math.max(0, Number(memory.expiresAt) || 0),
        recallLog: Array.isArray(memory.recallLog) ? memory.recallLog.slice(-10) : [],
      };
      // 2026-10-28：归档不再等于删除，归档原因/合并目标要跨进程保留。
      if (memory.archivedAt) out.memories[id].archivedAt = Number(memory.archivedAt);
      if (memory.archivedReason) out.memories[id].archivedReason = String(memory.archivedReason);
      if (memory.mergedInto) out.memories[id].mergedInto = String(memory.mergedInto);
      // v1.3：矛盾降权字段同样要跨进程保留，否则重启后旧记忆会重新参与召回。
      if (memory.supersededBy) out.memories[id].supersededBy = String(memory.supersededBy);
      if (memory.supersededAt) out.memories[id].supersededAt = Number(memory.supersededAt);
      if (memory.deprioritized !== undefined) out.memories[id].deprioritized = Boolean(memory.deprioritized);
      if (Array.isArray(memory.supersedes)) {
        out.memories[id].supersedes = memory.supersedes.map(String).filter(Boolean).slice(0, 20);
      }
      if (typeof memory.note === 'string' && memory.note) out.memories[id].note = memory.note;
    }
  }
  // v1.3：共激活突触（Hebbian）。只保留两端记忆仍存在的边，按 id 去重。
  if (Array.isArray(raw.synapses)) {
    const seen = new Set();
    for (const synapse of raw.synapses) {
      if (!synapse || typeof synapse !== 'object') continue;
      const from = String(synapse.from ?? '');
      const to = String(synapse.to ?? '');
      if (!from || !to || from === to) continue;
      if (!out.memories[from] || !out.memories[to]) continue;
      const pair = [from, to].sort();
      const synType = String(synapse.type || 'COACTIVATED');
      const key = `syn_${sha1(pair.join('|') + '|' + synType).slice(0, 16)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.synapses.push({
        id: key,
        from: pair[0],
        to: pair[1],
        type: synType,
        weight: clamp(Number(synapse.weight) || hebbianWeight(synapse.coactivations), 0, 1),
        coactivations: Math.max(0, Number(synapse.coactivations) || 0),
        lastAt: Number(synapse.lastAt) || Number(now),
        createdAt: Number(synapse.createdAt) || Number(now),
        updatedAt: Number(synapse.updatedAt) || Number(now),
      });
    }
  }
  return out;
}
