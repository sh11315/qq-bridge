/**
 * 情绪动力学（v1.10）：让情绪按「时间 / 当时的对话 / 记忆」自动变化，而不是只能手动设置。
 *
 * 设计原则：
 *   - 不引入外部依赖，纯函数；桥接在每次唤醒前调用一次，写入 brain.emotions（source='auto'）。
 *   - 三层输入各自有上限，避免被一句话或者一条旧记忆带跑：
 *       1) 时间：按时段给一个基线（凌晨疲惫、白天平稳、傍晚轻快）；
 *       2) 对话：从最新几条消息里识别夸奖/亲密/批评/玩笑/压力/难过，给一个有限的推力；
 *       3) 记忆：从与当前话题相关的旧记忆里找情绪词，给一个更弱的回声。
 *   - 所有变化都会向基线回落（半衰期 4 小时），强度夹在 0.05~0.95；主人手动设置始终优先。
 */

import { EMOTION_LABELS, EMOTION_PAD, normalizeEmotion } from './emotion.mjs';
import { textRelevance } from './model.mjs';

export const EMOTION_DYNAMICS_VERSION = 3;
export const EMOTION_HALF_LIFE_HOURS = 4;
export const EMOTION_TTL_MS = 12 * 60 * 60 * 1000;
export const EMOTION_MIN_INTENSITY = 0.05;
export const EMOTION_MAX_INTENSITY = 0.95;

const HOUR = 60 * 60 * 1000;
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n)));

/** 按时段给情绪基线（本地时间）。凌晨/深夜偏低，白天平稳，傍晚轻快。 */
export const HOUR_BASELINES = Object.freeze([
  { from: 0, to: 5, label: '疲惫', intensity: 0.5 },
  { from: 6, to: 8, label: '平静', intensity: 0.42 },
  { from: 9, to: 11, label: '开心', intensity: 0.45 },
  { from: 12, to: 14, label: '平静', intensity: 0.45 },
  { from: 15, to: 17, label: '开心', intensity: 0.5 },
  { from: 18, to: 21, label: '开心', intensity: 0.5 },
  { from: 22, to: 23, label: '疲惫', intensity: 0.46 },
]);

/** 对话推力规则：命中即给一个 pad 方向的推力（叠加，但整体有上限）。 */
export const DIALOG_RULES = Object.freeze([
  {
    id: 'praise',
    label: '开心',
    re: /(夸|可爱|好棒|真棒|厉害|喜欢你|谢谢|辛苦|乖|萌|厉害呀|好看)/,
    weight: 0.75,
    pad: { p: 0.6, a: 0.3, d: 0.2 },
  },
  {
    id: 'affection',
    label: '开心',
    re: /(亲亲|抱抱|想你|晚安|摸摸|贴贴|爱你)/,
    weight: 0.7,
    pad: { p: 0.55, a: 0.15, d: 0.25 },
  },
  {
    id: 'criticism',
    label: '委屈',
    re: /(笨蛋|笨死|好笨|烦人|好烦|滚|闭嘴|讨厌|差劲|傻瓜|不理你|不想理)/,
    weight: 0.85,
    pad: { p: -0.6, a: 0.35, d: -0.5 },
  },
  {
    id: 'apology',
    label: '平静',
    re: /(对不起|抱歉|我错了|别生气|不闹了)/,
    weight: 0.55,
    pad: { p: 0.15, a: -0.25, d: 0.1 },
  },
  {
    id: 'joke',
    label: '开心',
    re: /(哈哈|笑死|绷不住|乐死|草|太6了|笑不活)/,
    weight: 0.4,
    pad: { p: 0.35, a: 0.3, d: 0.1 },
  },
  {
    id: 'stress',
    label: '紧张',
    re: /(崩了|挂了|出问题|报错|救命|急死|来不及|要炸了)/,
    weight: 0.55,
    pad: { p: -0.35, a: 0.55, d: -0.35 },
  },
  {
    id: 'sad',
    label: '低落',
    re: /(难过|想哭|emo|伤心|好惨|难受|委屈)/,
    weight: 0.6,
    pad: { p: -0.55, a: -0.15, d: -0.35 },
  },
]);

/** 记忆里的情绪词 → 一个很轻的回声（旧事不该决定现在的心情）。 */
export const MEMORY_CUES = Object.freeze([
  { re: /(开心|高兴|笑|喜欢|好玩|可爱|顺利)/, pad: { p: 0.35, a: 0.15, d: 0.1 } },
  { re: /(难过|委屈|哭|伤心|低落|失败)/, pad: { p: -0.35, a: -0.15, d: -0.2 } },
  { re: /(烦|生气|气死|吵架|烦人|敷衍)/, pad: { p: -0.3, a: 0.3, d: -0.15 } },
  { re: /(累|困|熬夜|疲惫|加班)/, pad: { p: -0.2, a: -0.3, d: -0.15 } },
  { re: /(紧张|害怕|担心|考试|压力)/, pad: { p: -0.25, a: 0.3, d: -0.25 } },
]);

/** 按时段取基线情绪。 */
export function baselineByHour(now = Date.now()) {
  const hour = new Date(Number(now) || Date.now()).getHours();
  const row = HOUR_BASELINES.find((item) => hour >= item.from && hour <= item.to) || HOUR_BASELINES[1];
  const pad = { ...(EMOTION_PAD[row.label] || EMOTION_PAD.平静) };
  return { label: row.label, intensity: row.intensity, pad, at: Number(now) || Date.now(), reason: `${hour} 点时段基线（${row.label}）` };
}

/** 三维相加（各自夹到 -1..1）。 */
export function addPad(base, extra, scale = 1) {
  const out = {};
  for (const key of ['p', 'a', 'd']) {
    out[key] = round2(clamp((Number(base?.[key]) || 0) + (Number(extra?.[key]) || 0) * scale, -1, 1));
  }
  return out;
}

/** 按 PAD 最近距离归类到 8 个感受词。愉悦/唤醒权重高一点，掌控低一点。 */
export function classifyPad(pad) {
  const target = { p: Number(pad?.p) || 0, a: Number(pad?.a) || 0, d: Number(pad?.d) || 0 };
  let best = '平静';
  let bestScore = Infinity;
  for (const label of EMOTION_LABELS) {
    const base = EMOTION_PAD[label];
    const score = 1.2 * (target.p - base.p) ** 2 + 0.8 * (target.a - base.a) ** 2 + 0.6 * (target.d - base.d) ** 2;
    if (score < bestScore) {
      bestScore = score;
      best = label;
    }
  }
  return best;
}

/**
 * 对话推力：只看最新几条消息。群里减半（不是对我说的）；私聊/主人略加权。
 * @returns {{pad:object,intensity:number,hits:string[],reasons:string[]}}
 */
export function dialogImpulse(texts = [], { isGroup = false, fromOwner = false } = {}) {
  const source = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || '')).join('\n').slice(0, 1200);
  if (!source.trim()) return { pad: { p: 0, a: 0, d: 0 }, intensity: 0, hits: [], labels: [], reasons: [] };
  const strength = (isGroup ? 0.45 : 1) * (fromOwner ? 1.1 : 1);
  const hits = [];
  const labels = [];
  let pad = { p: 0, a: 0, d: 0 };
  let intensity = 0;
  const reasons = [];
  for (const rule of DIALOG_RULES) {
    if (!rule.re.test(source)) continue;
    hits.push(rule.id);
    if (!labels.includes(rule.label)) labels.push(rule.label);
    pad = addPad(pad, rule.pad, rule.weight * strength);
    intensity += rule.weight * strength * 0.45;
    reasons.push(`对话·${rule.id}`);
    if (hits.length >= 3) break;
  }
  intensity = Math.min(0.5, round2(intensity));
  return { pad, intensity, hits, labels, reasons };
}

/**
 * 记忆回声：只从和当前话有关的旧记忆里找情绪词，给很轻的推力。
 * @param {string[]} memories 相关记忆的文本（title+text）
 */
export function memoryEcho(memories = []) {
  const list = (Array.isArray(memories) ? memories : []).map((t) => String(t || '')).filter(Boolean).slice(0, 8);
  if (!list.length) return { pad: { p: 0, a: 0, d: 0 }, intensity: 0, hits: 0 };
  let pad = { p: 0, a: 0, d: 0 };
  let intensity = 0;
  let hits = 0;
  for (const text of list) {
    for (const cue of MEMORY_CUES) {
      if (!cue.re.test(text)) continue;
      hits += 1;
      pad = addPad(pad, cue.pad, 0.1);
      intensity += 0.03;
      break; // 一条记忆只算一次，避免同一段话里的多个词叠加
    }
    if (hits >= 3) break;
  }
  return { pad, intensity: Math.min(0.2, round2(intensity)), hits };
}

/** 当前情绪向时段基线回落（半衰期 4h）。 */
export function decayTowardBaseline(current, { now = Date.now(), baseline = baselineByHour(now) } = {}) {
  const at = Number(now) || Date.now();
  if (!current) return { label: baseline.label, intensity: baseline.intensity, pad: { ...baseline.pad }, reason: baseline.reason, factor: 0 };
  const hours = Math.max(0, (at - Number(current.at || at)) / HOUR);
  const factor = 0.5 ** (hours / EMOTION_HALF_LIFE_HOURS);
  const pad = {};
  for (const key of ['p', 'a', 'd']) {
    const base = Number(baseline.pad?.[key]) || 0;
    pad[key] = round2(clamp(base + ((Number(current.pad?.[key]) || 0) - base) * factor, -1, 1));
  }
  const intensity = round2(clamp(baseline.intensity + ((Number(current.intensity) || baseline.intensity) - baseline.intensity) * factor, EMOTION_MIN_INTENSITY, EMOTION_MAX_INTENSITY));
  return { label: classifyPad(pad), intensity, pad, factor: round2(factor), reason: `向${baseline.reason}回落` };
}

/**
 * 主入口：给当前情绪、对话文本、相关记忆和时刻，算出新的情绪。
 * @returns {{emotion:object, changed:boolean, reasons:string[], decayedFrom:string|null}}
 */

const SLEEP_START_HOUR = 0;
const SLEEP_END_HOUR = 6;
const SPECIAL_DAY_PATTERN = /(生日|纪念日|周年|第一次见面|约定日|领证|在一起)/;

/** 最近几条情绪的平均 PAD，用作情绪惯性（避免一次对话把情绪拽飞）。 */
export function analyzeRecentEmotions(emotions = [], now = Date.now(), options = {}) {
  const limit = Math.max(1, Math.min(5, Number(options.limit) || 3));
  const windowMs = Math.max(1, Math.min(24, Number(options.windowHours) || 6)) * HOUR;
  const rows = (Array.isArray(emotions) ? emotions : [])
    .filter((item) => item && Number(item.at) <= Number(now) && Number(now) - Number(item.at) <= windowMs && item.pad)
    .sort((a, b) => Number(a.at) - Number(b.at))
    .slice(-limit);
  if (!rows.length) return { pad: { p: 0, a: 0, d: 0 }, count: 0, weight: 0 };
  const sum = rows.reduce((acc, item) => ({
    p: acc.p + (Number(item.pad.p) || 0),
    a: acc.a + (Number(item.pad.a) || 0),
    d: acc.d + (Number(item.pad.d) || 0),
  }), { p: 0, a: 0, d: 0 });
  return { pad: { p: round2(sum.p / rows.length), a: round2(sum.a / rows.length), d: round2(sum.d / rows.length) }, count: rows.length, weight: 0.12 };
}

/** 从唤醒日志里算最近的作息：24 小时唤醒数、凌晨唤醒数、距上次唤醒多久。 */
export function analyzeWakeHistory(entries = [], now = Date.now()) {
  const rows = (Array.isArray(entries) ? entries : []).filter((item) => item && Number(item.at) <= Number(now));
  const since = Number(now) - 24 * HOUR;
  const today = rows.filter((item) => Number(item.at) >= since);
  const lateNight = today.filter((item) => {
    const hour = new Date(Number(item.at)).getHours();
    return hour >= SLEEP_START_HOUR && hour < SLEEP_END_HOUR;
  }).length;
  const lastAt = rows.length ? rows.reduce((max, item) => Math.max(max, Number(item.at)), 0) : 0;
  const gapHours = lastAt ? round2((Number(now) - lastAt) / HOUR) : null;
  return { wakes24h: today.length, lateNight, lastAt, gapHours };
}

/** 羁绊温度：关系类记忆、约定、生日等越多，基线越暖一点。 */
export function computeBondWarmth(brain = {}, now = Date.now()) {
  const warmTags = new Set(['relationship', '约定', '生日', '纪念日', '亲近', '喜欢', '家人', '朋友']);
  const memories = Object.values(brain?.memories || {}).filter((memory) => memory && memory.status !== 'archived' && memory.status !== 'superseded');
  let hits = 0;
  for (const memory of memories) {
    const tags = Array.isArray(memory.tags) ? memory.tags.map(String) : [];
    const category = String(memory.category || '');
    if (category === 'relationship' || category === 'promise' || tags.some((tag) => warmTags.has(tag))) hits += 1;
  }
  const narratives = Array.isArray(brain?.self?.narratives) ? brain.self.narratives.length : 0;
  const warmth = round2(Math.min(0.35, hits * 0.05 + narratives * 0.04));
  return { warmth, hits, narratives };
}

/** 今天是不是特别日子（生日/纪念日/约定日）：从记忆文本里找 MM-DD / MM月DD日。 */
export function findSpecialDay(memories = [], now = Date.now()) {
  const date = new Date(Number(now) || Date.now());
  const md = String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  const mdCn = (date.getMonth() + 1) + '月' + date.getDate() + '日';
  for (const text of Array.isArray(memories) ? memories : []) {
    const body = String(text || '');
    if (!SPECIAL_DAY_PATTERN.test(body)) continue;
    if (body.includes(md) || body.includes(mdCn)) return { hit: true, day: md, hint: body.slice(0, 60) };
  }
  return { hit: false, day: md, hint: '' };
}

/** 连续消息/群聊热闹程度：短时间话越密，唤起越高。 */
export function burstImpulse(count = 0, isGroup = false) {
  const n = Math.max(0, Number(count) || 0);
  if (n < 4) return { pad: { p: 0, a: 0, d: 0 }, reason: '' };
  const scale = isGroup ? 0.7 : 1;
  const a = round2(Math.min(0.3, 0.06 * (n - 3)) * scale);
  return { pad: { p: 0.03 * scale, a, d: -0.02 * scale }, reason: '连续消息·热闹' };
}

/** 久别重逢：超过 6 小时没说话，再开口会带一点新鲜感和靠近感。 */
export function reunionImpulse(gapHours) {
  if (gapHours === null || gapHours === undefined || !Number.isFinite(Number(gapHours))) return { pad: { p: 0, a: 0, d: 0 }, reason: '' };
  const gap = Number(gapHours);
  if (gap >= 24) return { pad: { p: 0.05, a: 0.06, d: 0.08 }, reason: '久别重逢·一天以上' };
  if (gap >= 6) return { pad: { p: 0.06, a: 0.05, d: 0.05 }, reason: '久别重逢·隔了几小时' };
  return { pad: { p: 0, a: 0, d: 0 }, reason: '' };
}

/** 睡眠债：凌晨还在被唤醒 / 连着几天熬夜，会真的更累。 */
export function sleepDebtImpulse(wakeStats = null, now = Date.now()) {
  const hour = new Date(Number(now) || Date.now()).getHours();
  const lateNight = Number(wakeStats?.lateNight) || 0;
  const inSleepWindow = hour >= SLEEP_START_HOUR && hour < SLEEP_END_HOUR;
  if (!inSleepWindow && lateNight < 2) return { pad: { p: 0, a: 0, d: 0 }, reason: '' };
  const severity = clamp((inSleepWindow ? 0.12 : 0) + lateNight * 0.05, 0, 0.25);
  return { pad: { p: round2(-severity * 0.9), a: round2(-severity * 0.8), d: round2(-severity * 0.5) }, reason: '睡眠债·有点累' };
}

const MEAL_WINDOWS = Object.freeze([
  { from: 11.5, to: 13, pad: { p: 0.06, a: 0.04, d: 0.02 }, reason: '饭点·吃饱一点' },
  { from: 17.5, to: 19, pad: { p: 0.06, a: 0.04, d: 0.02 }, reason: '饭点·吃饱一点' },
  { from: 13, to: 14.5, pad: { p: 0, a: -0.05, d: -0.02 }, reason: '饭后犯困' },
  { from: 19, to: 20.5, pad: { p: 0, a: -0.05, d: -0.02 }, reason: '饭后犯困' },
]);

/** 饭点：吃到饭会满足一点，饭后会犯困一点。 */
export function mealImpulse(now = Date.now()) {
  const date = new Date(Number(now) || Date.now());
  const hour = date.getHours() + date.getMinutes() / 60;
  const row = MEAL_WINDOWS.find((item) => hour >= item.from && hour <= item.to);
  return row ? { pad: { ...row.pad }, reason: row.reason } : { pad: { p: 0, a: 0, d: 0 }, reason: '' };
}

/** 语气：感叹号、笑声、省略号、连问，能读出情绪强度。 */
export function toneImpulse(texts = []) {
  const source = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || '')).join('\n').slice(0, 800);
  if (!source.trim()) return { pad: { p: 0, a: 0, d: 0 }, reason: '' };
  const exclaim = (source.match(/[!！]/g) || []).length;
  const laugh = /(哈{3,}|233|hhh|嘿嘿|哈哈)/i.test(source);
  const ellipsis = /(……|\.\.\.)/.test(source);
  const multiQuestion = /[?？]{2,}/.test(source);
  let pad = { p: 0, a: 0, d: 0 };
  const reasons = [];
  if (exclaim >= 2) { pad = addPad(pad, { p: 0.04, a: 0.12, d: 0.02 }, 1); reasons.push('语气·情绪挺高'); }
  if (laugh) { pad = addPad(pad, { p: 0.06, a: 0.1, d: 0.02 }, 1); reasons.push('语气·在笑'); }
  if (ellipsis) { pad = addPad(pad, { p: -0.03, a: -0.05, d: 0 }, 1); reasons.push('语气·有点泄气'); }
  if (multiQuestion) { pad = addPad(pad, { p: 0, a: 0.1, d: -0.05 }, 1); reasons.push('语气·连着追问'); }
  return { pad, reason: reasons.join('、') };
}

/** 熟悉度：陌生人会让她收着一点，熟人在场更放松。 */
export function familiarityImpulse({ knownSender = true, isGroup = false, fromOwner = false } = {}) {
  if (!knownSender) return { pad: { p: -0.03, a: 0.1, d: -0.08 }, reason: '陌生人·有点收着' };
  if (fromOwner) return { pad: { p: 0.03, a: 0, d: 0.05 }, reason: '熟人在场·放松' };
  if (isGroup) return { pad: { p: 0, a: 0.02, d: 0 }, reason: '' };
  return { pad: { p: 0, a: 0, d: 0 }, reason: '' };
}

/** 记忆里的旧矛盾 / 暖意：比通用情绪词更具体的「还没放下」和「还记得好」。 */
export function conflictMemoryImpulse(memories = []) {
  const list = (Array.isArray(memories) ? memories : []).map((t) => String(t || '')).filter(Boolean).slice(0, 8);
  let pad = { p: 0, a: 0, d: 0 };
  const reasons = [];
  for (const text of list) {
    if (/(吵架|生气|误会|冷战|争执|对不起|道歉)/.test(text)) { pad = addPad(pad, { p: -0.15, a: 0.12, d: -0.1 }, 1); reasons.push('旧矛盾·还没放下'); break; }
  }
  for (const text of list) {
    if (/(谢谢|想你|约定|答应|等你|抱抱|陪着我)/.test(text)) { pad = addPad(pad, { p: 0.1, a: 0.05, d: 0.06 }, 1); reasons.push('暖记忆·还记得好'); break; }
  }
  return { pad, reason: reasons.join('、') };
}

/** 刚做完事/刚碰到问题，会带一点成就感或急躁。 */
export function achievementImpulse(lastTurnText = '') {
  const text = String(lastTurnText || '').slice(0, 300);
  if (!text.trim()) return { pad: { p: 0, a: 0, d: 0 }, reason: '' };
  if (/(完成|修好|通过|搞定|解决|成功|跑通)/.test(text)) return { pad: { p: 0.08, a: 0.06, d: 0.08 }, reason: '刚做完事·有点得意' };
  if (/(失败|报错|崩了|不行|又被拒|卡住)/.test(text)) return { pad: { p: -0.06, a: 0.08, d: -0.06 }, reason: '刚碰到问题·有点急' };
  return { pad: { p: 0, a: 0, d: 0 }, reason: '' };
}
export function evaluateEmotionDynamics({
  current = null,
  texts = [],
  isGroup = false,
  fromOwner = false,
  memories = [],
  emotions = [],
  wakeStats = null,
  bond = null,
  specialDay = null,
  knownSender = true,
  lastTurnText = '',
  now = Date.now(),
} = {}) {
  const at = Number(now) || Date.now();
  const baseline = baselineByHour(at);
  const decayed = decayTowardBaseline(current, { now: at, baseline });
  const dialog = dialogImpulse(texts, { isGroup, fromOwner });
  const memory = memoryEcho(memories);
  const sleep = sleepDebtImpulse(wakeStats, at);
  const bondWarm = bond && Number(bond.warmth) > 0 ? { pad: { p: round2(Number(bond.warmth) * 0.6), a: round2(Number(bond.warmth) * 0.15), d: round2(Number(bond.warmth) * 0.4) }, reason: '羁绊温度 +' + Math.round(Number(bond.warmth) * 100) + '%' } : { pad: { p: 0, a: 0, d: 0 }, reason: '' };
  const special = specialDay && specialDay.hit ? { pad: { p: 0.25, a: 0.12, d: 0.1 }, reason: '特别日子·' + (specialDay.day || '') } : { pad: { p: 0, a: 0, d: 0 }, reason: '' };
  const reunion = reunionImpulse(wakeStats ? wakeStats.gapHours : null);
  const burst = burstImpulse(texts.length, isGroup);
  const inertia = analyzeRecentEmotions(emotions, at);
  const meal = mealImpulse(at);
  const tone = toneImpulse(texts);
  const familiar = familiarityImpulse({ knownSender, isGroup, fromOwner });
  const oldConflict = conflictMemoryImpulse(memories);
  const achievement = achievementImpulse(lastTurnText);

  let pad = { ...decayed.pad };
  pad = addPad(pad, sleep.pad, 1);
  pad = addPad(pad, bondWarm.pad, 1);
  pad = addPad(pad, special.pad, 1);
  pad = addPad(pad, reunion.pad, 1);
  pad = addPad(pad, burst.pad, 1);
  pad = addPad(pad, meal.pad, 1);
  pad = addPad(pad, tone.pad, 1);
  pad = addPad(pad, familiar.pad, 1);
  pad = addPad(pad, oldConflict.pad, 1);
  pad = addPad(pad, achievement.pad, 1);
  pad = {
    p: round2(clamp(pad.p * (1 - inertia.weight) + inertia.pad.p * inertia.weight, -1, 1)),
    a: round2(clamp(pad.a * (1 - inertia.weight) + inertia.pad.a * inertia.weight, -1, 1)),
    d: round2(clamp(pad.d * (1 - inertia.weight) + inertia.pad.d * inertia.weight, -1, 1)),
  };
  pad = addPad(pad, dialog.pad, 1);
  pad = addPad(pad, memory.pad, 1);

  let intensity = decayed.intensity + dialog.intensity + memory.intensity;
  if (sleep.reason) intensity -= 0.08;
  if (bondWarm.reason) intensity += 0.04;
  if (special.reason) intensity += 0.1;
  if (reunion.reason) intensity += 0.04;
  if (burst.reason) intensity += 0.05;
  if (inertia.count) intensity = intensity * (1 - inertia.weight) + (Number(current && current.intensity) || intensity) * inertia.weight;
  intensity = round2(clamp(intensity, EMOTION_MIN_INTENSITY, EMOTION_MAX_INTENSITY));
  // 单次唤醒最多比上一条高 0.15，避免连续几次唤醒把强度一路顶到 0.95 下不来。
  if (current) intensity = round2(Math.min(intensity, (Number(decayed.intensity) || 0) + 0.15));

  // 标签统一由 PAD 最近距离决定；对话规则只推动 PAD，不强行改标签，避免标签和数值打架。
  const label = classifyPad(pad);

  const reasons = [decayed.reason];
  for (const item of [sleep, bondWarm, special, reunion, burst, meal, tone, familiar, oldConflict, achievement]) {
    if (item.reason) reasons.push(item.reason);
  }
  if (dialog.reasons.length) reasons.push(...dialog.reasons);
  if (memory.hits) reasons.push('记忆回声 ' + memory.hits + ' 条');
  if (!current) reasons.unshift('初始化时段情绪');

  const emotion = normalizeEmotion({
    label,
    intensity,
    pad,
    at,
    expiresAt: at + EMOTION_TTL_MS,
    source: 'auto',
    note: reasons.join('；').slice(0, 200),
  }, at);

  let changed = true;
  if (current) {
    const prev = normalizeEmotion(current, at);
    const delta = Math.abs((prev.pad?.p ?? 0) - pad.p) + Math.abs((prev.pad?.a ?? 0) - pad.a) + Math.abs((prev.pad?.d ?? 0) - pad.d);
    changed = prev.label !== label || delta >= 0.04 || Math.abs((prev.intensity || 0) - intensity) >= 0.05;
  }

  return {
    emotion,
    changed,
    reasons,
    decayedFrom: current ? String(current.label || '') : null,
    baseline,
    impulses: {
      dialog: dialog.pad,
      memory: memory.pad,
      sleep: sleep.pad,
      bond: bondWarm.pad,
      special: special.pad,
      reunion: reunion.pad,
      burst: burst.pad,
      inertia: inertia.pad,
      meal: meal.pad,
      tone: tone.pad,
      familiar: familiar.pad,
      oldConflict: oldConflict.pad,
      achievement: achievement.pad,
      dialogHits: dialog.hits,
      memoryHits: memory.hits,
    },
  };
}

/**
 * 从 brain 里挑与当前话题最相关的最近记忆，作为「记忆回声」的输入。
 * 只取活跃、非日记、非归档的记忆；没有 query 时退化为最近更新的几条。
 */
export function selectEmotionMemories(brain, { query = '', limit = 8 } = {}) {
  const rows = Object.values(brain?.memories || {}).filter((memory) => {
    if (!memory) return false;
    if (memory.status === 'archived' || memory.status === 'superseded') return false;
    if (Array.isArray(memory.tags) && memory.tags.includes('diary')) return false;
    return Number(memory.strength ?? 0) > 0.1;
  });
  const text = (memory) => `${memory.title || ''}\n${memory.text || ''}`.trim().slice(0, 400);
  if (!String(query || '').trim()) {
    return rows.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).slice(0, limit).map(text);
  }
  return rows
    .map((memory) => {
      const relevance = textRelevance(query, memory);
      return { memory, relevance, score: relevance + (Number(memory.strength) || 0) * 0.1 };
    })
    // 有 query 时必须是文本真的相关；不能只因为记忆强度高就混进来当「回声」。
    .filter((row) => row.relevance >= 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => text(row.memory));
}
