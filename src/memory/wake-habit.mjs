// src/memory/wake-habit.mjs
// 唤醒习惯：每次醒来先翻一眼【记忆·置顶】和【此刻情绪】，再决定接不接话。
//
// 本模块刻意保持为「纯函数」：不读写文件、不 import model/emotion 等模块，
// 只接收 brain 对象（旧版/新版形状都容错），返回文案或整理后的数据。
// 这样 bridge 在唤醒时可以直接调用，测试也只需构造对象。
//
// 主要导出：
//   WAKE_HABIT_RULE                      固定习惯规则文案
//   WAKE_LOG_MAX_LINES                   唤醒日志最多保留行数（5000）
//   normalizeWakeLog(raw)                把任意输入整理成一条标准唤醒日志
//   appendWakeLogLine(prevLines, entry)  追加一行，返回「行数组」（每项不含换行符）
//   parseWakeLog(jsonlText)              解析 JSONL 文本，坏行/空行/BOM 全部容错
//   wakeHabitPrompt({ brain, now })      生成"醒来先看记忆"的中文短提示

export const WAKE_HABIT_RULE =
  '每次醒来先翻一遍【记忆·置顶】和【此刻情绪】再决定接不接话；不翻完不要开口。';

/** 唤醒日志最多保留 5000 行，避免一个月测试台把日志撑爆。 */
export const WAKE_LOG_MAX_LINES = 5000;

/** 与 src/memory/emotion.mjs 的 DEFAULT_EMOTION_TTL_MS 对齐（不 import，避免耦合版本差异）。 */
const EMOTION_TTL_MS = 24 * 60 * 60 * 1000;

/** pinRank 语义白名单：这些分类默认视为「置顶/高优先」。 */
const PINNED_CATEGORIES = new Set(['relationship', 'promise', 'profile']);
const PINNED_TAGS = new Set(['pinned', 'top']);
const TRUE_STRINGS = new Set(['true', '1', 'yes', 'y', 'on']);
const ACTIVE_STATUSES = new Set(['', 'active']);

function toBool(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') return TRUE_STRINGS.has(value.trim().toLowerCase());
  return false;
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

function toFiniteNumber(value, fallback = 0) {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function cleanLabel(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .slice(0, 12);
}

/** brain.memories 可能是对象 map（真实形状），也可能是数组（容错），统一成数组。 */
function memoryList(brain) {
  const raw = brain && typeof brain === 'object' ? brain.memories : null;
  if (Array.isArray(raw)) {
    return raw.filter((item) => item && typeof item === 'object');
  }
  if (raw && typeof raw === 'object') {
    return Object.values(raw).filter((item) => item && typeof item === 'object');
  }
  return [];
}

function isActiveMemory(memory) {
  const status = String(memory?.status ?? '').toLowerCase();
  return ACTIVE_STATUSES.has(status);
}

function isPinnedMemory(memory) {
  if (!memory || typeof memory !== 'object') return false;
  if (toBool(memory.pinned) || toBool(memory.top) || toBool(memory.isPinned)) return true;
  if (Number(memory.protection) >= 1 || memory.permanent === true) return true;
  const tags = Array.isArray(memory.tags)
    ? memory.tags.map((tag) => String(tag).trim().toLowerCase())
    : [];
  if (tags.some((tag) => PINNED_TAGS.has(tag))) return true;
  const category = String(memory.category ?? '').trim();
  return PINNED_CATEGORIES.has(category);
}

function titleOf(memory) {
  const raw = String(memory?.title ?? memory?.text ?? memory?.id ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!raw) return '';
  return raw.length > 24 ? `${raw.slice(0, 24)}…` : raw;
}

/**
 * 置顶记忆列表。
 * 兼容三种来源：
 *   1) brain.top = ['mem_x', {id:'mem_y', title:'...'}, ...]（显式置顶，优先）
 *   2) brain.memories 里单条记忆自带 pinned/top/protection/permanent/tags/category 标记
 *   3) brain.memories 为数组
 * 注意：仅当 brain.top 非空时优先；空的 top 数组仍会回退到 memories 推导。
 */
function topMemories(brain) {
  const memories = memoryList(brain);
  const byId = new Map();
  for (const memory of memories) {
    const id = String(memory?.id ?? '');
    if (id) byId.set(id, memory);
  }

  const explicit = brain?.top;
  if (Array.isArray(explicit) && explicit.length > 0) {
    const result = [];
    const seen = new Set();
    for (const item of explicit) {
      let memory = null;
      if (typeof item === 'string') {
        memory = byId.get(item) ?? null;
      } else if (item && typeof item === 'object') {
        memory = item.title || item.text ? item : byId.get(String(item.id ?? '')) ?? item;
      }
      if (!memory || typeof memory !== 'object') continue;
      const id = String(memory.id ?? '');
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      result.push(memory);
    }
    if (result.length > 0) return result;
  }

  return memories
    .filter((memory) => isActiveMemory(memory) && isPinnedMemory(memory))
    .sort(
      (a, b) =>
        toMs(b.lastActivatedAt) - toMs(a.lastActivatedAt) ||
        toMs(b.updatedAt) - toMs(a.updatedAt),
    );
}

/** 「相关」= 记忆库里还活着、但不算置顶的普通记忆条数。 */
function relatedCount(brain, top) {
  const topIds = new Set(top.map((memory) => String(memory?.id ?? '')).filter(Boolean));
  let count = 0;
  for (const memory of memoryList(brain)) {
    if (!isActiveMemory(memory)) continue;
    const id = String(memory?.id ?? '');
    if (id && topIds.has(id)) continue;
    if (isPinnedMemory(memory)) continue;
    count += 1;
  }
  return count;
}

/**
 * 取「此刻情绪」记录：
 *   - 优先 brain.emotions 数组（emo-runtime 形状：{label,intensity,at,expiresAt}）
 *   - 其次 brain.emotion 单条、brain.self.emotions
 *   - 过期（超过 TTL / expiresAt）的不算
 */
function pickEmotionRecord(brain, now) {
  const rawList = [];
  if (Array.isArray(brain?.emotions)) rawList.push(...brain.emotions);
  if (brain?.emotion && typeof brain.emotion === 'object') rawList.push(brain.emotion);
  if (rawList.length === 0 && Array.isArray(brain?.self?.emotions)) {
    rawList.push(...brain.self.emotions);
  }

  const candidates = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const label = cleanLabel(item.label ?? item.emotion ?? item.name);
    if (!label) continue;
    const at = toMs(item.at ?? item.createdAt);
    const expiresAt = toMs(item.expiresAt);
    const effectiveExpiry = expiresAt || (at > 0 ? at + EMOTION_TTL_MS : 0);
    if (effectiveExpiry > 0 && effectiveExpiry <= now) continue;
    if (at > 0 && at > now + 60 * 1000) continue;
    const intensity = clamp01(toFiniteNumber(item.intensity ?? item.strength, 0.5));
    candidates.push({ label, intensity, at });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.at - a.at);
  return candidates[0];
}

function emotionToText(record) {
  if (!record) return null;
  const label = record.label;
  const intensity = clamp01(toFiniteNumber(record.intensity, 0.5));
  if (label === '平静' || label === 'neutral') return '平静';
  if (intensity >= 0.7) return `挺${label}`;
  if (intensity >= 0.35) return `有点${label}`;
  return `有一点点${label}`;
}

/** 没有情绪记录时退到 brain.state.mood 的档位（与 model.personaStateSnapshot 的 moodWord 对齐）。 */
function moodToText(mood) {
  if (mood > 0.45) return '心情挺好';
  if (mood > 0.15) return '还不错';
  if (mood < -0.45) return '情绪有点低';
  if (mood < -0.15) return '有点闷';
  return '平静';
}

function currentEmotionText(brain, now) {
  const record = pickEmotionRecord(brain, now);
  if (record) return emotionToText(record);
  const mood = Number(brain?.state?.mood);
  if (Number.isFinite(mood)) return moodToText(mood);
  return '平静';
}

/**
 * 情绪强度 → 语气指令。
 *
 * 之前情绪只用来复读一句「现在心情还不错」，不影响怎么说话，等于挂件。
 * 这里把 label + intensity 翻成一句**行为**提示：烦就短、软就软、开心可以多补一句。
 * 低强度不返回任何东西，免得每句话都被情绪牵着走。
 *
 * @returns {string} 空串表示不需要干预
 */
export function emotionToneHint(record) {
  if (!record) return '';
  const label = String(record.label || '').trim();
  if (!label) return '';
  const intensity = clamp01(toFiniteNumber(record.intensity, 0.5));
  if (intensity < 0.35 || label === '平静' || label === 'neutral') return '';
  // PAD 三维优先：同样是「难受」，烦躁（高唤醒）要短要硬，低落（低唤醒）要少而软，
  // 只看标签和单标量强度，这两种会撞成同一句。
  const pad = record.pad && typeof record.pad === 'object' ? record.pad : null;
  if (pad) {
    const p = toFiniteNumber(pad.p, 0);
    const a = toFiniteNumber(pad.a, 0);
    if (a >= 0.55 && p < -0.2) return '火气还在，但别冲他撒；回得短，句子硬一点。';
    if (p >= 0.5 && a >= 0.5) return '兴致高，可以多补一句，语气放开点。';
    if (p <= -0.5 && a <= -0.2) return '人往下沉，话少而软，别硬撑热络。';
  }
  const strong = intensity >= 0.7;
  const map = {
    烦躁: strong ? '这会儿烦，回得短、句子硬一点，别解释太多。' : '句子短些，少接闲话。',
    // 2026-11-22 用户反馈「心情没影响语气」：原来只写「话再短些」，模型会当长度提示照做、
    // 情绪照旧。这里给可执行的行为约束（句数/语气词/句尾/开话题），才真的会改变措辞。
    疲惫: strong ? '话更短：一到两句就够，别用「哈哈」「～」「呀」凑热络，句尾别带笑，不主动开新话题。' : '别写长句，收着说。',
    开心: strong ? '可以多补一句，语气松一点，别收得太紧。' : '语气放松一点。',
    兴奋: strong ? '可以连着说两句，带点感叹。' : '可以稍微热一点。',
    低落: strong ? '心里往下沉：语气平着说，句子短，不硬撑热络、不主动找话，也不用装没事。' : '语气低一点，不多解释。',
    紧张: '别铺垫，直接说事。',
    委屈: '可以带一点软，但别卖惨。',
  };
  return map[label] || '';
}


/**
 * 生成「醒来先看记忆」提示。
 * 输出固定格式：
 *   醒来先看记忆：现在有 N 条置顶（标题…）、N 条相关、此刻情绪：xxx；看完再决定要不要开口。
 *
 * @param {{ brain?: object, now?: number, anchors?: Array<object|string> }} [options]
 *   anchors：按关键度（salience）挑出来的「压底」条目，可选；传了就追加一句，不传输出不变。
 * @returns {string}
 */
export function wakeHabitPrompt({ brain, now, anchors } = {}) {
  const safeBrain = brain && typeof brain === 'object' ? brain : {};
  const at = toMs(now) || Date.now();

  const top = topMemories(safeBrain);
  const topTitles = top
    .map(titleOf)
    .filter(Boolean)
    .slice(0, 3);
  const topText = topTitles.length
    ? `${topTitles.join('、')}${top.length > 3 ? '…' : ''}`
    : '无';
  const related = relatedCount(safeBrain, top);
  const emotion = currentEmotionText(safeBrain, at);
  const anchorTitles = (Array.isArray(anchors) ? anchors : [])
    .map((item) => (typeof item === 'string' ? item.trim() : titleOf(item)))
    .filter(Boolean)
    .slice(0, 3);
  const anchorText = anchorTitles.length ? `，压底 ${anchorTitles.length} 条（${anchorTitles.join('、')}）` : '';

  // 情绪由 formatMemoryHint 的【此刻情绪】单独注入，这里再说一遍会重复、还容易两处不一致。
  return `醒来先看记忆：现在有 ${top.length} 条置顶（${topText}）、${related} 条相关${anchorText}；看完再决定要不要开口。`;
}

/**
 * 把任意输入（对象 / JSON 字符串）整理成标准唤醒日志。
 * 返回值固定 8 个键：{at,key,sawPinned,sawRelated,sawEmotion,proactive,sent,replyLen}。
 * 缺省值：数值 0、布尔 false、key 空字符串；at 为毫秒时间戳。
 */
export function normalizeWakeLog(raw) {
  let input = raw;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      input = null;
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};

  const rawKey = input.key ?? input.sessionKey ?? '';
  const key =
    typeof rawKey === 'string'
      ? rawKey.trim().slice(0, 200)
      : String(rawKey ?? '').trim().slice(0, 200);
  const replyLen = Math.max(
    0,
    Math.round(toFiniteNumber(input.replyLen ?? input.replyLength, 0)),
  );

  return {
    at: toMs(input.at ?? input.time ?? input.ts),
    key,
    sawPinned: toBool(input.sawPinned ?? input.seenPinned),
    sawRelated: toBool(input.sawRelated ?? input.seenRelated),
    sawEmotion: toBool(input.sawEmotion ?? input.seenEmotion),
    proactive: toBool(input.proactive),
    sent: toBool(input.sent ?? input.sentReply),
    replyLen,
  };
}

/**
 * 追加一条唤醒日志，返回新的「行数组」（每项不含换行符，写盘时 join('\n') + '\n'）。
 * 超过 WAKE_LOG_MAX_LINES 行时丢弃最旧的，保证只保留最近 5000 行。
 *
 * @param {string[]|string} prevLines 旧日志行数组，或整段 JSONL 文本
 * @param {object|string} entry       新日志（对象或 JSON 字符串）
 * @returns {string[]}
 */
export function appendWakeLogLine(prevLines, entry) {
  const lines = [];
  if (Array.isArray(prevLines)) {
    for (const item of prevLines) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed) lines.push(trimmed);
      } else if (item && typeof item === 'object') {
        lines.push(JSON.stringify(normalizeWakeLog(item)));
      }
    }
  } else if (typeof prevLines === 'string') {
    for (const line of prevLines.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) lines.push(trimmed);
    }
  }
  lines.push(JSON.stringify(normalizeWakeLog(entry)));
  return lines.slice(-WAKE_LOG_MAX_LINES);
}

/**
 * 解析 wake-log.jsonl 文本。
 * 容错：BOM、空行、JSON 坏行、非对象行（数组/字符串/数字）一律跳过并继续。
 * @param {string} jsonlText
 * @returns {object[]} 标准化后的日志数组
 */
export function parseWakeLog(jsonlText) {
  if (typeof jsonlText !== 'string' || !jsonlText) return [];
  const text = jsonlText.replace(/^\uFEFF/, '');
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    entries.push(normalizeWakeLog(parsed));
  }
  return entries;
}
