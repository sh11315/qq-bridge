// 记忆「关键度」分级（2026-10-31，小雪喵自己提的那一条）
//
// 起因：饭饭问「怎么定什么算关键」。情绪能当筛子，但光靠情绪会偏——
// 难受的时候什么都会显得重要，平静下来又什么都轻。所以这里给一个
// 「不肯动的东西」：跟当时的情绪无关，只看记忆本身的硬指标。
//
// 设计原则：
// - 纯函数、零依赖、可离线，和 model.mjs 里其它打分保持同一风格；
// - 分数只回答「这条值不值得留得久」，不参与检索排序（检索另有 scoreMemory）；
// - 锚定物：主人亲手点的永久 / 承诺 / 人物 / 显式锚词 / 被反复提起 / 图里的连接。
// - 情绪只能加一点点（≤0.05），不让它推翻上面的硬指标。

const MARKER_RE = /(记住|别忘|永久|一辈子|约定|答应|说定|赖不掉|不许忘)/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const SALIENCE_TIERS = Object.freeze({
  core: { key: 'core', label: '核心', min: 0.62, decayFactor: 6 },
  important: { key: 'important', label: '重要', min: 0.15, decayFactor: 2 },
  normal: { key: 'normal', label: '普通', min: 0, decayFactor: 1 },
});

export function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * 关键度打分。
 * @param {object} memory 记忆记录
 * @param {object} [ctx]
 * @param {number} [ctx.relations] 这条记忆在关系图里的度数
 * @param {object} [ctx.entityTypes] 关联实体按类型计数，如 { person: 1, group: 1 }
 * @param {number} [ctx.emotionAt] 当时那条情绪的时间戳（只管一点点）
 */
export function salienceScore(memory = {}, { relations = 0, entityTypes = {}, emotionAt = 0 } = {}) {
  let score = 0;

  // 1. 主人亲手点的永久：最硬的一票，谁也不能把它冲掉。
  if (Number(memory.protection) >= 1) score += 0.34;

  // 2. 分类权重：承诺比情绪重，人物档案比闲聊重。
  const category = String(memory.category || '');
  if (category === 'promise') score += 0.16;
  else if (category === 'profile') score += 0.12;
  else if (category === 'preference') score += 0.06;
  else if (category === 'relationship') score += 0.08;

  // 3. 正文里有没有显式的锚词（「记住」「别忘」「说定了」这类）。
  const hay = `${memory.title || ''} ${memory.text || ''}`;
  if (MARKER_RE.test(hay)) score += 0.1;

  // 4. 挂着具体的人：越具体越值得留。
  const people = Number(entityTypes.person) || 0;
  if (people >= 2) score += 0.08;
  else if (people >= 1) score += 0.05;

  // 5. 被反复提起过：重复本身就是一种投票（对数，防一条刷满）。
  const acts = Number(memory.activationCount) || 0;
  score += Math.min(0.12, Math.log2(1 + acts) * 0.04);

  // 6. 图里连着的越多，越不像孤立的一句闲话。
  const degree = Number(relations) || 0;
  if (degree >= 3) score += 0.05;
  else if (degree >= 1) score += 0.02;

  // 7. 长期层本来就该留得久一点。
  if (memory.layer === 'long') score += 0.04;

  // 8. 情绪只当助力，而且必须真的新鲜（24 小时内），不许压倒硬指标。
  const at = Number(emotionAt) || 0;
  if (at > 0 && Date.now() - at <= DAY_MS) score += 0.05;

  // 9. 永久是「压着不动」的那一票：只要点了永久，分数至少落在核心里，
  //    不让任何别的因子把它算回普通档。
  const clamped = clamp01(score);
  const floored = Number(memory.protection) >= 1 ? Math.max(clamped, SALIENCE_TIERS.core.min) : clamped;
  return Math.round(floored * 1000) / 1000;
}

export function salienceTier(score) {
  const value = clamp01(score);
  if (value >= SALIENCE_TIERS.core.min) return SALIENCE_TIERS.core.key;
  if (value >= SALIENCE_TIERS.important.min) return SALIENCE_TIERS.important.key;
  return SALIENCE_TIERS.normal.key;
}

/**
 * 按关键度调整衰减天数：核心的活得久，普通的按原样走。
 * 永久记忆（protection=1）直接返回 Infinity，不参与衰减。
 */
export function adjustedDecayDays(memory = {}, baseDays = 30, ctx = {}) {
  if (Number(memory.protection) >= 1) return Infinity;
  const tier = salienceTier(salienceScore(memory, ctx));
  const factor = SALIENCE_TIERS[tier]?.decayFactor || 1;
  const base = Number(baseDays) > 0 ? Number(baseDays) : 30;
  return Math.round(base * factor);
}

/** 挑出该压在最底下的几条：醒来先看 / 长期注入时用。 */
export function pickAnchors(memories = [], { limit = 5, ctxOf = () => ({}) } = {}) {
  return (Array.isArray(memories) ? memories : [])
    .filter((item) => item && item.status !== 'archived' && item.status !== 'superseded')
    .map((memory) => ({ memory, score: salienceScore(memory, ctxOf(memory)) }))
    .sort((a, b) => b.score - a.score || (Number(b.memory.updatedAt) || 0) - (Number(a.memory.updatedAt) || 0))
    .slice(0, Math.max(1, Number(limit) || 5));
}
