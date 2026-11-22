/**
 * 会话健康度判定：什么时候该把一个 QQ 会话的 DSH 上下文轮换掉。
 *
 * 为什么需要它（2026-10-26 真实事故）：
 *   群 group:100000003 从 00:42 起连续 20+ 个回合 `output = 1` token、零工具调用，
 *   表现为「群里叫它不回」。桥接当时只能看到「回合结束了但 AI 没做任何事」，
 *   于是每两轮重置一次唤醒配置 —— 治的是症状，会话本身一直是坏的，直到人工重置才恢复。
 *   事后实测网关能吃 373k token 的 prompt 并正常回答，所以这不是简单的「上下文超限」，
 *   而是会话状态本身进了不可恢复的坏态。**结论：判据要用症状，不要用 token 数去猜模型上限。**
 *
 * 设计约束：
 *  1. **纯函数**：不读文件、不碰配置、不看时间（now 由调用方传）。判定逻辑可以离线跑测试。
 *  2. **两个独立判据**：连续空回合（强信号）、单轮 prompt 过大（弱信号，防成本无上限增长）。
 *  3. **0 / 负数 = 关闭该项**：和项目里其它阈值配置的习惯一致。
 *  4. **冷却只挡轮换、不清计数**：冷却期内仍然累积空回合，冷却一过立刻能轮换；
 *     反过来「冷却期清零」会让反复坏掉的会话永远等不到下一次轮换。
 *  5. **坏数据一律按健康处理**：NaN / 负数 / 非对象输入不能误触发轮换 —— 轮换是有代价的
 *     （上下文清空 + agentToken 轮换），宁可漏判也不能误判。
 */

export const DEFAULT_SESSION_HEALTH_LIMITS = Object.freeze({
  /** 连续多少个「零工具调用」的回合后轮换会话。0 = 关闭。 */
  emptyTurnsBeforeRotate: 2,
  /** 单轮 prompt token 达到多少就轮换（防成本无上限增长）。0 = 关闭。 */
  maxPromptTokens: 300000,
  /** 同一会话两次自动轮换之间的最小间隔。 */
  rotateCooldownMs: 10 * 60 * 1000,
});

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** 把外部配置（可能是字符串 / undefined / 负数）归一化成可用阈值。 */
export function normalizeSessionHealthLimits(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pick = (key) => {
    const d = DEFAULT_SESSION_HEALTH_LIMITS[key];
    const v = src[key];
    if (v === undefined || v === null || v === '') return d;
    const n = num(v, d);
    return n >= 0 ? n : d;
  };
  return {
    emptyTurnsBeforeRotate: Math.round(pick('emptyTurnsBeforeRotate')),
    maxPromptTokens: Math.round(pick('maxPromptTokens')),
    rotateCooldownMs: Math.round(pick('rotateCooldownMs')),
  };
}

/**
 * @param {object} input
 * @param {number} input.emptyTurnStreak 连续零工具调用的回合数
 * @param {number} input.promptTokens    最近一轮的 prompt token 数
 * @param {number} input.lastRotateAt    上次自动轮换的时间戳（0 = 从未）
 * @param {number} input.now             当前时间戳
 * @param {object} [input.limits]        阈值（见 DEFAULT_SESSION_HEALTH_LIMITS）
 * @returns {{rotate: boolean, reason: 'healthy'|'empty-turns'|'prompt-tokens'|'cooldown', streak: number, promptTokens: number, limits: object}}
 */
export function decideSessionRotation(input) {
  const src = input && typeof input === 'object' ? input : {};
  const limits = normalizeSessionHealthLimits(src.limits);
  const now = num(src.now, Date.now());
  const streak = Math.max(0, Math.round(num(src.emptyTurnStreak, 0)));
  const promptTokens = Math.max(0, Math.round(num(src.promptTokens, 0)));
  const lastRotateAt = Math.max(0, num(src.lastRotateAt, 0));

  const base = { streak, promptTokens, limits };

  const cooling = lastRotateAt > 0 && now - lastRotateAt < limits.rotateCooldownMs;
  if (cooling) return { rotate: false, reason: 'cooldown', ...base };

  const emptyHit = limits.emptyTurnsBeforeRotate > 0 && streak >= limits.emptyTurnsBeforeRotate;
  const tokenHit = limits.maxPromptTokens > 0 && promptTokens >= limits.maxPromptTokens;
  if (emptyHit) return { rotate: true, reason: 'empty-turns', ...base };
  if (tokenHit) return { rotate: true, reason: 'prompt-tokens', ...base };
  return { rotate: false, reason: 'healthy', ...base };
}
