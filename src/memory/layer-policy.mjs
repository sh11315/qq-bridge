// 记忆层级策略（纯函数，2026-11-22）
// 背景：在「记忆大脑」里看到大量一次性事件/测试记录躺在长期层、空日层也进长期层，
// 层级实际上由调用方随手传 `layer` 决定，长期层被稀释。这里把「哪条记忆该进哪层」
// 收敛成一条可测试的规则，service 在写入/激活时统一调用：
//   · 日层摘要、日记、承诺、长期偏好、关系、档案 → 长期
//   · 事件、事实、话题等一次性内容 → 默认短期；被反复想起（激活次数足够）或标了永久/高保护 → 升长期
//   · 模型显式指定的层仍然尊重（它更清楚这条事实的分量）；存量里「长期 + 一次性分类」的旧数据
//     由 retierMemories 按同一规则清理，而不是在写入时把模型的判断一律推翻。
export const LAYER_LONG = 'long';
export const LAYER_SHORT = 'short';

/** 天然长期：这些东西一旦记错、忘掉都会伤人，默认落长期层。 */
export const LONG_TERM_CATEGORIES = Object.freeze(['promise', 'preference', 'relationship', 'profile']);
/** 天然短期：一次性事件/零散事实/当下话题，靠反复使用上位。 */
export const SHORT_TERM_CATEGORIES = Object.freeze(['event', 'fact', 'topic', 'other']);

/** 短期记忆被激活到这个次数后升长期（等价于「被反复想起才站得住」）。 */
export const PROMOTE_AFTER_ACTIVATIONS = 3;
/** 保护线：与 model 的 protectionLine 默认值一致。 */
export const PROTECTION_LINE = 0.5;

const LONG_SET = new Set(LONG_TERM_CATEGORIES);
const SHORT_SET = new Set(SHORT_TERM_CATEGORIES);

function normalizeLayer(value) {
  return value === LAYER_LONG || value === LAYER_SHORT ? value : null;
}

/**
 * 写入时决定层级。
 * @param {object} input
 * @param {string|null} [input.requested] 调用方显式要求的层（模型传的 layer）
 * @param {string} [input.category] 分类
 * @param {boolean} [input.isDiary] 是否日记（tag 里带 diary）
 * @param {boolean} [input.isDay] 是否日层摘要
 * @param {boolean} [input.permanent] 是否永久
 * @param {number} [input.protection] 保护值 0~1
 * @param {number} [input.activationCount] 已有激活次数（新建为 0）
 * @returns {'long'|'short'}
 */
export function decideMemoryLayer(input = {}) {
  const category = String(input.category ?? '').trim();
  const requested = normalizeLayer(input.requested);
  const activationCount = Math.max(0, Number(input.activationCount) || 0);
  const protection = Math.max(0, Math.min(1, Number(input.protection) || 0));

  if (input.isDay === true) return LAYER_LONG; // 日层是归档，不是一次性记忆
  if (input.isDiary === true) return LAYER_LONG; // 日记：回顾用
  if (input.permanent === true) return LAYER_LONG;
  if (protection >= PROTECTION_LINE) return LAYER_LONG;
  if (LONG_SET.has(category)) return LAYER_LONG;
  // 模型显式指定的层优先；只有没指定时才按分类兜底（一次性内容默认短期）。
  if (requested) return requested;
  return LAYER_SHORT;
}

/**
 * 已存在的短期记忆是否该升长期（在 _activate 里调用）。
 * 日记/永久/日层不参与；类别本身属于长期层的也不走这里（写入时已是长期）。
 */
export function shouldPromoteToLong(memory, { promotionsAfter = PROMOTE_AFTER_ACTIVATIONS } = {}) {
  if (!memory || typeof memory !== 'object') return false;
  if (memory.layer === LAYER_LONG) return false; // 已是长期
  if (memory.permanent === true) return false;
  const category = String(memory.category ?? '').trim();
  if (LONG_SET.has(category)) return false;
  const tags = Array.isArray(memory.tags) ? memory.tags : [];
  if (tags.some((tag) => String(tag).trim().toLowerCase() === 'diary')) return false;
  if (category === 'day') return false;
  const count = Math.max(0, Number(memory.activationCount) || 0);
  return count >= Math.max(1, Number(promotionsAfter) || PROMOTE_AFTER_ACTIVATIONS);
}

/**
 * 存量迁移：给一条已存在的记忆算出「层级策略认为它现在该在哪层」。
 * @returns {{layer: 'long'|'short', reason: string}|null} null = 不动
 */
export function decideRetierLayer(memory) {
  if (!memory || typeof memory !== 'object') return null;
  if (!memory.id) return null;
  if (memory.status === 'archived' || memory.status === 'superseded') return null;
  if (memory.permanent === true) return null;
  const tags = Array.isArray(memory.tags) ? memory.tags : [];
  const isDiary = tags.some((tag) => String(tag).trim().toLowerCase() === 'diary');
  const category = String(memory.category ?? '').trim();
  if (isDiary || category === 'day') return null; // 日记/日层保持长期
  // 存量迁移看「按分类该落哪层」，不看它现在挂在哪层，否则永远不会调整。
  const desired = decideMemoryLayer({
    requested: null,
    category,
    isDiary,
    isDay: category === 'day',
    permanent: memory.permanent === true,
    protection: memory.protection,
    activationCount: memory.activationCount,
  });
  const current = normalizeLayer(memory.layer) ?? LAYER_SHORT;
  if (desired === current) return null;
  // 已经是长期、且被反复想起（够升级线）的短期类记忆，视为「挣来的长期」，不再往回降。
  if (current === LAYER_LONG && (Number(memory.activationCount) || 0) >= PROMOTE_AFTER_ACTIVATIONS) return null;
  return {
    layer: desired,
    reason: desired === LAYER_LONG ? 'promote-earned' : 'demote-transient',
  };
}
