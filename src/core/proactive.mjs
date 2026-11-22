/**
 * 「主动机会」纯函数：决定这一刻要不要自己开口、以什么由头开口。
 *
 * 设计目标（活人感）：
 *   - 不是固定概率抽奖，而是随「安静时长」增长的机会曲线：刚聊完几乎不打扰，越久越可能冒泡；
 *   - 有时间感：深夜极低、早晚更自然；有「上次没聊完的事」时加成；
 *   - 有上限：每小时 / 每天硬上限，防刷屏；
 *   - 有由头：followup（接上次话题）/ thought（事还没说完）/ mood（分享心情）/ share（分享点小事）/ poke（戳一下）。
 *   - 允许沉默：即使命中机会，也可以由模型判断「没话可说」而安静收尾。
 *
 * 纯函数、零依赖，便于单测与调参。
 */

export const DEFAULT_PROACTIVE_POLICY = {
  enabled: true,
  checkIntervalMinMs: 3 * 60 * 1000,       // 判定间隔下限（3 分钟）
  checkIntervalMaxMs: 10 * 60 * 1000,      // 判定间隔上限（10 分钟）
  idleThresholdMs: 15 * 60 * 1000,         // 群聊安静多久才考虑主动
  privateIdleThresholdMs: 25 * 60 * 1000,  // 私聊安静多久才考虑主动
  probability: 0.3,                        // 群聊每次判定的基础概率
  privateProbability: 0.55,                // 私聊每次判定的基础概率
  maxPerHourGroup: 2,
  maxPerHourPrivate: 3,
  maxPerDayGroup: 8,
  maxPerDayPrivate: 16,
  privateCooldownMs: 30 * 60 * 1000,       // 私聊两次主动之间至少隔 30 分钟
  quietHours: { start: 1, end: 8 },        // 静默时段（1:00~8:00）
  quietFactor: 0.08,                       // 静默时段概率乘数（quietHardBlock=false 时才生效）
  quietHardBlock: true,                    // 静默时段直接跳过：只压概率的话，一晚的检查次数足够把额度耗光
  recentAiPenalty: 0.35,                   // 群里自己刚刷过 5 条以上时的惩罚
  followupBonus: 0.2,                      // 有「上次没聊完」的话题时加成
  thoughtBonus: 0.1,                       // 有 pendingThought 时加成
  cueBonus: 0.35,                          // 手上有件具体的事（由头清单命中的话）加成
  dayCapWindowMs: 24 * 60 * 60 * 1000,
  // 由头多样性：最近用过的由头降权，避免每次都用同一种套路。
  diversityPenalty: 0.35,                  // 最近窗口内每出现一次同由头，权重 ×(1 - penalty)
  recentKindsWindow: 5,                    // 最近 N 次主动由头参与多样性计算
  // 按回复热度调整：上次主动有没有人接，决定这次更积极/更收敛。
  replyHeatWindow: 8,                      // 最近 N 次主动结果参与热度计算
  replyHeatMinFactor: 0.6,                 // 热度 0 时概率乘数（收敛）
  replyHeatMaxFactor: 1.4,                 // 热度 1 时概率乘数（更积极）
  heatHighThresholdScale: 0.85,            // 回复热时安静阈值缩短
  heatLowThresholdScale: 1.25,             // 回复冷时安静阈值拉长
  proactiveOutcomeWindowMs: 2 * 60 * 60 * 1000, // 一次主动超过这么久没人接，记为「未回复」
};

export const PROACTIVE_KIND_LABELS = {
  cue: '有件具体的事',
  followup: '接上次话题',
  thought: '补没说完的话',
  mood: '分享心情',
  share: '分享小事',
  poke: '拍一拍/表情',
  idle: '轻轻开口',
};

/** 最近的主动结果（replied 布尔）→ 回复热度 0~1；没历史时返回 null（不干预）。 */
export function computeReplyHeat(outcomes, { window = DEFAULT_PROACTIVE_POLICY.replyHeatWindow } = {}) {
  const list = Array.isArray(outcomes)
    ? outcomes.filter((item) => item && typeof item.replied === 'boolean').slice(-Math.max(1, Number(window) || 8))
    : [];
  if (!list.length) return { heat: null, replied: 0, total: 0 };
  const replied = list.filter((item) => item.replied).length;
  return { heat: replied / list.length, replied, total: list.length };
}

export function clamp01(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

/**
 * 情绪/记忆对「主动机会」的调节：让主动冒泡的频率和语气跟着心情、记忆走。
 * - 疲惫/低落：更晚给自己开口的机会、概率更低、语气更收；
 * - 开心/兴奋：更早、更大胆；
 * - 记忆里有料（进行中的话题/惦记的事/在意的）：更容易开口，并给一个「顺着记忆聊」的语气提示。
 */
export function computeMoodModifiers(input = {}) {
  const label = String(input.emotionLabel || '').trim();
  const intensity = Math.max(0, Math.min(1, Number(input.intensity) || 0));
  const memoryBias = Math.max(-1, Math.min(1, Number(input.memoryBias) || 0));
  const reasons = [];
  let probabilityScale = 1;
  let thresholdScale = 1;
  let toneHint = '';

  const heavy = /疲惫|累|低落|难过|烦|撑不住|没力气/.test(label);
  const bright = /开心|高兴|兴奋|愉快|好|雀跃|得意/.test(label);

  if (heavy && intensity >= 0.7) {
    probabilityScale *= 0.45;
    thresholdScale *= 1.6;
    toneHint = '这会儿有点乏/情绪低：真要开口就一两句，别开新话题、别硬撑热络，也可以只发个很短的反应。';
    reasons.push(`心情「${label}」偏重（${Math.round(intensity * 100)}%）→ 主动更收敛`);
  } else if (heavy) {
    probabilityScale *= 0.7;
    thresholdScale *= 1.25;
    toneHint = '心情有点往下沉：语气平一点，句子短，不用硬找话题。';
    reasons.push(`心情「${label}」偏低 → 主动收敛一些`);
  } else if (bright && intensity >= 0.6) {
    probabilityScale *= 1.35;
    thresholdScale *= 0.85;
    toneHint = '心情不错：可以更主动、更松一点，话里带点劲儿也行。';
    reasons.push(`心情「${label}」偏亮（${Math.round(intensity * 100)}%）→ 主动更大胆`);
  } else if (bright) {
    probabilityScale *= 1.15;
    thresholdScale *= 0.95;
    toneHint = '';
  }

  if (memoryBias > 0.02) {
    probabilityScale *= 1 + 0.3 * memoryBias;
    thresholdScale *= 1 - 0.2 * memoryBias;
    reasons.push('记忆里有能接着聊的料（进行中的话题/惦记的事）');
  } else if (memoryBias < -0.02) {
    probabilityScale *= 1 + 0.2 * memoryBias;
    reasons.push('最近记忆里没什么可聊的由头');
  }

  return {
    label,
    intensity,
    memoryBias,
    probabilityScale: Math.max(0.05, probabilityScale),
    thresholdScale: Math.max(0.5, thresholdScale),
    toneHint,
    reasons,
    summary: toneHint ? `心情 ${label || '未知'}${intensity ? `/${Math.round(intensity * 100)}%` : ''}：${reasons.join('；') || '按心情调节主动频率'}` : '',
  };
}

export function normalizeQuietHours(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const start = Number.isFinite(Number(src.start)) ? Math.min(23, Math.max(0, Math.floor(Number(src.start)))) : 1;
  const end = Number.isFinite(Number(src.end)) ? Math.min(24, Math.max(0, Math.floor(Number(src.end)))) : 8;
  return { start, end };
}

/** 是否处于静默时段；支持跨午夜（如 22~7）。 */
export function isQuietHour(hour, quietHours) {
  const { start, end } = normalizeQuietHours(quietHours);
  const h = ((Number(hour) % 24) + 24) % 24;
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}

function pickByWeight(entries, random) {
  const total = entries.reduce((sum, item) => sum + (item.weight > 0 ? item.weight : 0), 0);
  if (total <= 0) return entries[0] ? entries[0].kind : null;
  let threshold = clamp01(random, 0.5) * total;
  for (const item of entries) {
    if (item.weight <= 0) continue;
    threshold -= item.weight;
    if (threshold <= 0) return item.kind;
  }
  const last = entries.filter((item) => item.weight > 0).pop();
  return last ? last.kind : null;
}

/** 选一个主动由头；调用方传入随机数便于测试。 */
export function pickProactiveKind({ isPrivate, hasFollowup, hasPendingThought, recentKinds = [], policy = DEFAULT_PROACTIVE_POLICY, random = Math.random } = {}) {
  const roll = typeof random === 'function' ? random() : random;
  const window = Math.max(1, Number(policy.recentKindsWindow) || 5);
  const recent = Array.isArray(recentKinds) ? recentKinds.map(String).filter(Boolean).slice(-window) : [];
  const penalty = clamp01(Number(policy.diversityPenalty) || 0, 0.35);
  const varietyFactor = (kind) => {
    const used = recent.filter((item) => item === kind).length;
    let factor = Math.max(0.15, 1 - penalty * used);
    if (recent.length && recent[recent.length - 1] === kind) factor *= 0.5; // 连着两次同由头再压一半
    return factor;
  };
  const entries = [
    { kind: 'followup', weight: hasFollowup ? 1.5 : 0 },
    { kind: 'thought', weight: hasPendingThought ? 1.0 : 0 },
    { kind: 'mood', weight: isPrivate ? 0.8 : 0.5 },
    { kind: 'share', weight: 1.0 },
    { kind: 'poke', weight: isPrivate ? 0.45 : 0.7 },
    { kind: 'idle', weight: 1.0 },
  ].map((item) => ({ ...item, weight: item.weight > 0 ? item.weight * varietyFactor(item.kind) : 0 }));
  return pickByWeight(entries, roll);
}

function pruneWindow(list, now, windowMs) {
  const arr = Array.isArray(list) ? list.map(Number).filter((n) => Number.isFinite(n) && n > 0 && now - n < windowMs) : [];
  return arr.slice(-100);
}

/**
 * 主决策函数（纯函数）。
 * @returns {{allow:boolean, probability:number, idleMs:number, idleMinutes:number, kind:string|null,
 *   reasons:string[], hourHistory:number[], dayHistory:number[], quiet:boolean, capHit:string|null}}
 */
export function evaluateProactiveOpportunity(input = {}, random = Math.random) {
  const now = Number(input.now) || Date.now();
  const policy = { ...DEFAULT_PROACTIVE_POLICY, ...(input.policy || {}) };
  policy.quietHours = normalizeQuietHours(policy.quietHours);
  const isPrivate = Boolean(input.isPrivate);
  const idleMs = Math.max(0, Number(input.idleMs) || 0);
  const baseIdleThreshold = isPrivate ? Number(policy.privateIdleThresholdMs) : Number(policy.idleThresholdMs);
  const heat = input.replyHeat === null || input.replyHeat === undefined || !Number.isFinite(Number(input.replyHeat))
    ? null
    : clamp01(input.replyHeat, 0.5);
  const heatFactor = heat === null
    ? 1
    : clamp01(Number(policy.replyHeatMinFactor) || 0.6, 0.6) + (Number(policy.replyHeatMaxFactor) - Number(policy.replyHeatMinFactor)) * heat;
  const thresholdScale = heat === null
    ? 1
    : (heat >= 0.6 ? (Number(policy.heatHighThresholdScale) || 0.85) : (heat <= 0.35 ? (Number(policy.heatLowThresholdScale) || 1.25) : 1));
  const mood = computeMoodModifiers({
    emotionLabel: input.emotionLabel,
    intensity: input.emotionIntensity,
    memoryBias: input.memoryBias,
  });
  const idleThreshold = Math.max(60 * 1000, Math.round(baseIdleThreshold * thresholdScale * mood.thresholdScale));
  const recentKinds = Array.isArray(input.recentKinds) ? input.recentKinds.map(String).filter(Boolean).slice(-Math.max(1, Number(policy.recentKindsWindow) || 5)) : [];
  const hour = Number.isFinite(Number(input.hour)) ? Number(input.hour) : new Date(now).getHours();
  const quiet = isQuietHour(hour, policy.quietHours);
  const hourHistory = pruneWindow(input.hourHistory, now, 60 * 60 * 1000);
  const dayHistory = pruneWindow(input.dayHistory, now, Number(policy.dayCapWindowMs) || DEFAULT_PROACTIVE_POLICY.dayCapWindowMs);
  const reasons = [];
  if (mood.reasons.length) reasons.push(...mood.reasons);

  let probability = clamp01(isPrivate ? policy.privateProbability : policy.probability, 0);
  if (!Number.isFinite(Number(policy.privateProbability)) || !Number.isFinite(Number(policy.probability))) {
    probability = clamp01(DEFAULT_PROACTIVE_POLICY.probability, 0.3);
  }

  // 1) 安静时长：达到阈值才进入判定；越久越容易开口（在阈值基础上缓慢爬升）。
  if (idleMs < idleThreshold) {
    return { allow: false, probability: 0, idleMs, idleMinutes: Math.round(idleMs / 60000), kind: null, reasons: mood.reasons.length ? [...mood.reasons, '还没到安静阈值'] : ['还没到安静阈值'], hourHistory, dayHistory, mood, moodTone: mood.toneHint, quiet, capHit: null, heatFactor, heat, effectiveThresholdMs: idleThreshold };
  }
  const idleRatio = Math.max(0, idleMs / Math.max(1, idleThreshold) - 1);
  const idleBoost = Math.min(0.35, idleRatio * 0.12);
  probability += idleBoost;
  reasons.push(`安静 ${Math.round(idleMs / 60000)} 分钟（阈值 ${Math.round(idleThreshold / 60000)}）`);

  // 2) 由头加成：上次没聊完 / 心里还惦记着一句话 / 手上有件具体的事。
  if (input.hasFollowup) { probability += Number(policy.followupBonus) || 0; reasons.push('有上次没聊完的话题'); }
  if (input.hasPendingThought) { probability += Number(policy.thoughtBonus) || 0; reasons.push('心里还有一句想说的'); }
  if (input.hasCue) { probability += Number(policy.cueBonus) || 0; reasons.push('手上有件具体的事（由头清单）'); }

  // 2.5) 按回复热度调整：有人接话就更大胆，总被冷落就收敛。
  if (heat !== null) {
    probability *= heatFactor;
    if (thresholdScale !== 1) reasons.push(`按最近回复热度调整阈值 ×${thresholdScale}`);
    if (heatFactor !== 1) reasons.push(`回复热度 ${Math.round(heat * 100)}%（概率 ×${heatFactor.toFixed(2)}）`);
  }

  // 3) 时段：静默时段不打扰。默认直接跳过——只压低概率不够，夜里检查次数多，
  //    一晚下来照样会命中几次（那些「机会」还会吃掉当天的主动额度）。
  if (quiet && policy.quietHardBlock !== false) {
    return { allow: false, probability: 0, idleMs, idleMinutes: Math.round(idleMs / 60000), kind: null, reasons: [...reasons, '静默时段，直接跳过'], hourHistory, dayHistory, quiet, capHit: null, heatFactor, mood, moodTone: mood.toneHint, heat, effectiveThresholdMs: idleThreshold, recentKinds };
  }
  probability *= mood.probabilityScale;
  if (quiet) { probability *= Number(policy.quietFactor) || 0.08; reasons.push('静默时段'); }

  // 4) 最近自己刷屏过多时收敛。
  const recentAiCount = Number(input.recentAiCount) || 0;
  if (!isPrivate && recentAiCount >= 5) { probability *= Number(policy.recentAiPenalty) || 0.35; reasons.push('自己刚刷过屏'); }

  // 5) 私聊冷却：两次主动之间至少隔一段时间。
  const lastProactiveAt = Number(input.lastProactiveAt) || 0;
  if (isPrivate && lastProactiveAt && now - lastProactiveAt < (Number(policy.privateCooldownMs) || 0)) {
    probability = 0;
    reasons.push('私聊冷却中');
  }

  // 6) 硬上限：每小时 / 每天。
  let capHit = null;
  const hourCap = isPrivate ? Number(policy.maxPerHourPrivate) : Number(policy.maxPerHourGroup);
  const dayCap = isPrivate ? Number(policy.maxPerDayPrivate) : Number(policy.maxPerDayGroup);
  if (Number.isFinite(hourCap) && hourHistory.length >= hourCap) { probability = 0; capHit = 'hour'; reasons.push('本小时主动次数已满'); }
  if (Number.isFinite(dayCap) && dayHistory.length >= dayCap) { probability = 0; capHit = 'day'; reasons.push('今天主动次数已满'); }

  probability = clamp01(probability);
  const allow = probability > 0 && random < probability;
  const kind = allow
    ? (input.hasCue ? 'cue' : pickProactiveKind({ isPrivate, hasFollowup: Boolean(input.hasFollowup), hasPendingThought: Boolean(input.hasPendingThought), recentKinds, policy, random }))
    : null;
  return { allow, probability, idleMs, idleMinutes: Math.round(idleMs / 60000), kind, reasons, hourHistory, dayHistory, quiet, capHit, heatFactor, heat, mood, moodTone: mood.toneHint, effectiveThresholdMs: idleThreshold, recentKinds };
}

function timeOfDayWord(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  if (h < 5) return '凌晨';
  if (h < 9) return '早上';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 22) return '晚上';
  return '夜里';
}

/** 生成给模型的「这次主动的由头」提示；不写死文案，只给角度与边界。 */
export function buildProactiveBrief({ kind, isPrivate, idleMinutes, hour, lastTurnSummary, pendingThought, cueText, cueAngle, cueLateMinutes, moodTone, recentKinds = [], random = Math.random } = {}) {
  const h = Number.isFinite(Number(hour)) ? Number(hour) : new Date().getHours();
  const idleText = Number(idleMinutes) > 0 ? `已经安静了约 ${idleMinutes} 分钟` : '安静了一阵子';
  const summary = String(lastTurnSummary || '').trim().slice(0, 120);
  const thought = String(pendingThought || '').trim().slice(0, 100);
  const lines = ['【这次主动的由头】' + (isPrivate ? '私聊' : '群聊') + '，' + timeOfDayWord(h) + '，' + idleText + '。'];
  const angles = {
    cue: (() => {
      const text = String(cueText || '').trim().slice(0, 100);
      const angle = String(cueAngle || '').trim().slice(0, 160);
      const late = Number(cueLateMinutes) > 0 ? `（这件事其实已经到点 ${Math.round(Number(cueLateMinutes))} 分钟了）` : '';
      const head = text ? `你手上有件具体的事：「${text}」${late}。` : '你手上有件具体的事要说。';
      return head + (angle ? `开口角度：${angle}` : '自然地提一句，别写得像提醒通知。');
    })(),
    followup: summary
      ? `接上次没聊完的话：上次聊到「${summary}」。可以顺着问一句后来怎样了，或补一句你现在的想法。`
      : '接上次没聊完的话：翻一下最近记录，挑一件还没收尾的小事接着聊。',
    thought: thought
      ? `你之前一直惦记着「${thought}」，现在可以自然提一句。`
      : '你之前有句话没说完，可以现在补一句。',
    mood: '说说你此刻的心情或一点点小感想，不要报数值，也别硬凹情绪。',
    share: '分享一件刚想到的小事 / 一点小发现 / 一个最近在意的东西，不用长篇，像随手发消息。',
    poke: '这次可以皮一下：拍一拍对方、发个表情包，或者只来一句很短的话，不一定要有正文。',
    idle: '没什么特别的事，就是想说句话。用很轻的方式开口，别像汇报。',
  };
  lines.push(angles[kind] || angles.idle);
  const tone = String(moodTone || '').trim().slice(0, 120);
  if (tone) lines.push('此刻语气：' + tone);
  const openers = ['可以是一句半截话、一个表情、一声叹气', '别每次都从「在吗」开始，也别写总结', '可以分成两条发：先一句话，停一会儿再补一句'];
  lines.push('活人感：' + openers[Math.floor(clamp01(random, 0.5) * openers.length)] + '；这次只发 1~2 条，每条尽量短。');
  const recent = Array.isArray(recentKinds) ? recentKinds.map(String).filter(Boolean).slice(-3) : [];
  if (kind && recent.includes(kind)) {
    lines.push(`上次主动也是「${PROACTIVE_KIND_LABELS[kind] || kind}」，这次换个方式，别重复同一套路。`);
  } else if (recent.length >= 2 && recent[recent.length - 1] === recent[recent.length - 2]) {
    lines.push('最近两次由头有点重复了，这次务必换个角度。');
  }
  lines.push('如果这会儿其实没什么想说的，就安静收尾，不用为了主动而硬凑。');
  return lines.join('\n');
}
