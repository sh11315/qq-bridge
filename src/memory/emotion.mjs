// 情绪/语气运行时 —— 纯函数模块（无 fs / 无网络 / 无副作用）。
//
// 背景：v1.6 记忆系统新增"情绪"层。情绪是一条带时间戳的短状态（来源可能是模型自报、
// 群聊气氛或主人反馈），只在唤醒时由 auto-recall 注入成"语气提示"：影响说话的语气，
// 但不把情绪说成数值或标签复读；24h 后自动失效、不再复读。
// 持久化与归档由 store/service 负责，本文件只做归一化、过滤、提示词生成与剪枝。
//
// 所有函数都把 now 作为显式参数（默认 Date.now()），保证可复现、可回放、易测试。
import { createHash } from 'node:crypto';

/** 合法情绪标签（顺序即展示优先级）。不在列表里的情绪一律归"平静"。 */
export const EMOTION_LABELS = Object.freeze([
  '烦躁',
  '低落',
  '平静',
  '开心',
  '疲惫',
  '紧张',
  '兴奋',
  '委屈',
]);

/** 情绪默认有效期：24 小时。超过后不再注入/复读。 */
export const DEFAULT_EMOTION_TTL_MS = 24 * 60 * 60 * 1000;

// 情绪强度的三档阈值（强 / 中 / 轻），只用于挑选语气措辞，不对外暴露数字。
const STRONG_INTENSITY = 0.7;
const MEDIUM_INTENSITY = 0.35;

// 语气措辞的时间前缀：刚发生的说"现在"，稍早说"刚才"，更早说"之前"。
const JUST_NOW_MS = 10 * 60 * 1000;
const RECENT_MS = 3 * 60 * 60 * 1000;

const DEFAULT_INTENSITY = 0.5;
const SOURCE_MAX = 120;
const NOTE_MAX = 200;
const ID_MAX = 80;
const ID_PREFIX = 'emo_';

/**
 * 各情绪 × 强度档的语气谓词（不含时间前缀，拼接后如"刚才有点烦躁"）。
 * 只描述感受，不出现数字/分值，避免把情绪说成数值。
 */
const PROMPT_PREDICATES = Object.freeze({
  烦躁: Object.freeze({ strong: '挺烦躁的', medium: '有点烦躁', light: '心里有一点点烦' }),
  低落: Object.freeze({ strong: '情绪挺低的', medium: '心里有点闷', light: '心情稍微有点沉' }),
  平静: Object.freeze({ strong: '心里挺平静的', medium: '还算平静', light: '心情淡淡的' }),
  开心: Object.freeze({ strong: '心情特别好', medium: '心情还不错', light: '心情稍微好了一点' }),
  疲惫: Object.freeze({ strong: '累得有点撑不住', medium: '有点累了', light: '稍微有点乏' }),
  紧张: Object.freeze({ strong: '特别紧张', medium: '有点紧张', light: '心里有点打鼓' }),
  兴奋: Object.freeze({ strong: '兴奋得不行', medium: '还有点兴奋', light: '心里有点小激动' }),
  委屈: Object.freeze({ strong: '心里挺委屈的', medium: '有点委屈', light: '心里有一点点不是滋味' }),
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** 归一化到 0..1 并保留两位小数。 */
function round2(value) {
  return Math.round(clamp(value, 0, 1) * 100) / 100;
}

function sha1(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex');
}

function toTimestamp(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 来源归一：字符串保留，对象优先 kind:key（兼容记忆系统的 source 结构）。 */
function normalizeSource(value) {
  if (value && typeof value === 'object') {
    const kind = String(value.kind ?? '').trim();
    const key = String(value.key ?? '').trim();
    if (kind && key) return `${kind}:${key}`.slice(0, SOURCE_MAX);
    if (kind) return kind.slice(0, SOURCE_MAX);
    if (key) return key.slice(0, SOURCE_MAX);
    return 'self';
  }
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, SOURCE_MAX) : 'self';
}

/** 备注归一：压缩空白、限长；纯空白视为空串。 */
function normalizeNote(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, NOTE_MAX) : '';
}

/** 强度分档：强 / 中 / 轻（用绝对值，兼容未来可能出现的带符号强度）。 */
function intensityTier(intensity) {
  const magnitude = Math.abs(Number(intensity) || 0);
  if (magnitude >= STRONG_INTENSITY) return 'strong';
  if (magnitude >= MEDIUM_INTENSITY) return 'medium';
  return 'light';
}

/** 按"从发生到现在"的时长挑选时间前缀。 */
function timeWordFor(ageMs) {
  if (ageMs <= JUST_NOW_MS) return '现在';
  if (ageMs <= RECENT_MS) return '刚才';
  return '之前';
}

/**
 * 是否已失效：到达 expiresAt，或（保险起见）距发生已超过 24h。
 * 两个条件取并集：24h 是硬上限，expiresAt 允许调用方提前让某条情绪失效。
 */
function isEmotionExpired(emotion, now) {
  if (now >= emotion.expiresAt) return true;
  return now - emotion.at > DEFAULT_EMOTION_TTL_MS;
}

// ---------------------------------------------------------------------------
// 对外纯函数
// ---------------------------------------------------------------------------

/**
 * 归一化一条情绪。
 * raw 允许是对象（标准）或字符串（直接当 label）；非法 label 归"平静"；
 * intensity 限制在 0..1（缺省/非数值取 0.5）；id 缺省时由 label+at 生成稳定短 id。
 *
 * @param {object|string|null} raw
 * @param {number} [now]
 * @returns {{id:string,label:string,intensity:number,at:number,expiresAt:number,source:string,note:string}}
 */
export function normalizeEmotion(raw, now = Date.now()) {
  const baseNow = toTimestamp(now, Date.now());
  const value =
    typeof raw === 'string'
      ? { label: raw }
      : raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw
        : {};

  const labelRaw = String(value.label ?? '').trim();
  const label = EMOTION_LABELS.includes(labelRaw) ? labelRaw : '平静';

  const rawIntensity = value.intensity;
  let intensity =
    rawIntensity == null || rawIntensity === ''
      ? DEFAULT_INTENSITY
      : Number.isFinite(Number(rawIntensity))
        ? round2(rawIntensity)
        : DEFAULT_INTENSITY;

  const at = toTimestamp(value.at, baseNow);
  const expiresAt = toTimestamp(value.expiresAt, at + DEFAULT_EMOTION_TTL_MS);

  // PAD 三维（愉悦/唤醒/掌控，各 -1..1）：单标量 intensity 会把「烦躁」和「低落」
  // 压成同一个数，三维才分得开。旧记录没有 pad，就按 label 的默认值补上，读取端统一。
  const pad = normalizePad(value.pad, label);
  // 给了 pad 却没给 intensity 时，用唤醒度 + 愉悦度的强度推一个标量，保持旧接口可用。
  // 只有**显式给了 pad** 才用三维反推标量；没给 pad 的老写法保持 0.5 默认值不变。
  if ((rawIntensity == null || rawIntensity === '') && value.pad && typeof value.pad === 'object') {
    const magnitude = Math.max(Math.abs(pad.p), Math.abs(pad.a), Math.abs(pad.d));
    if (magnitude > 0) intensity = round2(Math.min(1, Math.max(0, magnitude)));
  }

  const providedId = typeof value.id === 'string' ? value.id.trim() : '';
  const id = providedId
    ? providedId.slice(0, ID_MAX)
    : `${ID_PREFIX}${sha1(`${label}|${at}`).slice(0, 12)}`;

  return {
    id,
    label,
    intensity,
    pad,
    at,
    expiresAt,
    source: normalizeSource(value.source),
    note: normalizeNote(value.note),
  };
}

/**
 * PAD（Pleasure-Arousal-Dominance）默认值表：给 8 个感受词各一组基准三维。
 * 只作缺省，模型/控制台可以传自定义 pad 覆盖。
 */
export const EMOTION_PAD = Object.freeze({
  烦躁: { p: -0.5, a: 0.7, d: -0.2 },
  低落: { p: -0.6, a: -0.4, d: -0.5 },
  平静: { p: 0.1, a: 0, d: 0.2 },
  开心: { p: 0.7, a: 0.4, d: 0.3 },
  疲惫: { p: -0.3, a: -0.6, d: -0.4 },
  紧张: { p: -0.4, a: 0.6, d: -0.6 },
  兴奋: { p: 0.6, a: 0.8, d: 0.3 },
  委屈: { p: -0.5, a: 0.2, d: -0.6 },
});

/** 三维各自夹到 -1..1；缺省或非法时退回 label 的基准值。 */
export function normalizePad(raw, label = '平静') {
  const fallback = EMOTION_PAD[label] || EMOTION_PAD.平静;
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const pick = (value, base) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return base;
    // 注意：不能复用上面的 round2（它按 0..1 夹），PAD 是 -1..1，负数会被压成 0。
    return Math.round(Math.min(1, Math.max(-1, num)) * 100) / 100;
  };
  return {
    p: pick(src?.p, fallback.p),
    a: pick(src?.a, fallback.a),
    d: pick(src?.d, fallback.d),
  };
}

/**
 * 当前仍然有效的情绪：未过期、且发生时间不晚于 now，按 at 升序。
 * items 里的条目会先归一化，因此旧数据/缺字段的条目也能安全参与。
 */
export function activeEmotions(items, now = Date.now()) {
  const baseNow = toTimestamp(now, Date.now());
  const list = Array.isArray(items) ? items : [];
  const active = [];
  for (const item of list) {
    if (!item) continue;
    const emotion = normalizeEmotion(item, baseNow);
    if (emotion.at > baseNow) continue;
    if (isEmotionExpired(emotion, baseNow)) continue;
    active.push(emotion);
  }
  active.sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
  return active;
}

/** 最新一条有效情绪（at 最大）；没有有效情绪时返回 null。 */
export function latestEmotion(items, now = Date.now()) {
  const active = activeEmotions(items, now);
  return active.length ? active[active.length - 1] : null;
}

/**
 * 生成用于注入的语气短句（中文、口语化、不带数字）。
 * 按 label + 强度分档挑措辞，再加时间前缀；超过 24h 或 expiresAt 已过 / 尚未发生返回 null。
 * 示例："刚才有点烦躁"、"现在心情还不错"。
 *
 * @param {object|null} emotion
 * @param {number} [now]
 * @returns {string|null}
 */
export function emotionPrompt(emotion, now = Date.now()) {
  if (!emotion) return null;
  const baseNow = toTimestamp(now, Date.now());
  const normalized = normalizeEmotion(emotion, baseNow);
  // 尚未发生的情绪不该被说成"现在"的感受。
  if (normalized.at > baseNow) return null;
  if (isEmotionExpired(normalized, baseNow)) return null;

  const tier = intensityTier(normalized.intensity);
  const predicates = PROMPT_PREDICATES[normalized.label] || PROMPT_PREDICATES['平静'];
  const predicate = predicates[tier] || predicates.light;
  return `${timeWordFor(baseNow - normalized.at)}${predicate}`;
}

/**
 * 剪枝：把仍然有效的留进 kept，已过期的放进 expired（供归档/事件记录）。
 * 尚未发生的条目不算过期，保留在 kept（由调用方决定如何处理脏数据）。
 *
 * @returns {{kept:object[],expired:object[]}}
 */
export function pruneEmotions(items, now = Date.now()) {
  const baseNow = toTimestamp(now, Date.now());
  const list = Array.isArray(items) ? items : [];
  const kept = [];
  const expired = [];
  for (const item of list) {
    if (!item) continue;
    const emotion = normalizeEmotion(item, baseNow);
    if (isEmotionExpired(emotion, baseNow)) expired.push(emotion);
    else kept.push(emotion);
  }
  return { kept, expired };
}
