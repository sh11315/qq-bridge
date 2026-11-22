// 群聊表达风格画像（纯统计，不存原话、不调用模型）。
//
// 参照 astrbot_plugin_fish_style_evolution 的核心取舍：
//   · 学的是“怎么说”（句长、短句比例、语气词、问句/感叹号、笑点密度），不是内容；
//   · 有样本门槛与时间跨度门槛，不达标连统计结果都不采纳；
//   · 只增不改 + 保留最近几个版本（可回滚）；
//   · 变化太小不更新，避免画像抖动。
//
// 这里只放纯函数；样本缓冲、落盘与注入在 bridge/store。

export const STYLE_DEFAULTS = Object.freeze({
  enabled: true,
  inject: true,
  minSamples: 120,
  minSpanHours: 72,
  maxProfiles: 200,
  freezeDays: 7,
  maxVersions: 3,
  minDistance: 0.15
});

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function normalizeStyleConfig(raw = {}) {
  const merged = { ...STYLE_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    ...merged,
    enabled: merged.enabled !== false,
    inject: merged.inject !== false,
    minSamples: clampInt(merged.minSamples, 20, 5000, STYLE_DEFAULTS.minSamples),
    minSpanHours: clampInt(merged.minSpanHours, 1, 24 * 30, STYLE_DEFAULTS.minSpanHours),
    maxProfiles: clampInt(merged.maxProfiles, 10, 2000, STYLE_DEFAULTS.maxProfiles),
    freezeDays: clampInt(merged.freezeDays, 1, 30, STYLE_DEFAULTS.freezeDays),
    maxVersions: clampInt(merged.maxVersions, 1, 10, STYLE_DEFAULTS.maxVersions),
    minDistance: Math.min(1, Math.max(0.01, Number(merged.minDistance) || STYLE_DEFAULTS.minDistance))
  };
}

const round = (value, digits = 3) => {
  const f = 10 ** digits;
  return Math.round((Number(value) || 0) * f) / f;
};

/**
 * @param {Array<{text?:string,isSelf?:boolean,time?:number}>} messages
 * @returns {object} 统计特征（不含原文）
 */
export function extractStyleFeatures(messages) {
  const rows = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.isSelf)
    .map((m) => ({ text: String(m.text ?? '').trim(), time: Number(m.time) || 0 }))
    .filter((m) => m.text);
  const sampleCount = rows.length;
  if (!sampleCount) {
    return {
      sampleCount: 0, avgLen: 0, shortRatio: 0, questionRatio: 0, exclaimRatio: 0,
      laughRatio: 0, emojiRatio: 0, particleRatio: 0, ellipsisRatio: 0,
      firstAt: 0, lastAt: 0
    };
  }
  let lenSum = 0;
  let short = 0;
  let question = 0;
  let exclaim = 0;
  let laugh = 0;
  let emoji = 0;
  let particle = 0;
  let ellipsis = 0;
  const times = [];
  for (const row of rows) {
    const text = row.text;
    lenSum += text.length;
    if (text.length <= 6) short += 1;
    if (/[?？]/.test(text)) question += 1;
    if (/[!！]/.test(text)) exclaim += 1;
    if (/哈{2,}|233|hhh|笑死|乐死|绷不住/i.test(text)) laugh += 1;
    if (/\[(表情|图片)|😀|😂|🤣|🥲|😭|😅|👍|🙏/u.test(text)) emoji += 1;
    if (/[啊呀吧呢嘛咯啦哦诶嘿]/.test(text)) particle += 1;
    if (/\.{3}|…/.test(text)) ellipsis += 1;
    if (row.time) times.push(row.time);
  }
  times.sort((a, b) => a - b);
  return {
    sampleCount,
    avgLen: round(lenSum / sampleCount, 1),
    shortRatio: round(short / sampleCount),
    questionRatio: round(question / sampleCount),
    exclaimRatio: round(exclaim / sampleCount),
    laughRatio: round(laugh / sampleCount),
    emojiRatio: round(emoji / sampleCount),
    particleRatio: round(particle / sampleCount),
    ellipsisRatio: round(ellipsis / sampleCount),
    firstAt: times[0] || 0,
    lastAt: times[times.length - 1] || 0
  };
}

/** 特征 → 一句人话（注入给模型）。 */
export function buildStyleSummary(features) {
  if (!features || !features.sampleCount) return '';
  const parts = [];
  if (features.avgLen <= 10) parts.push('句子偏短');
  else if (features.avgLen >= 22) parts.push('句子偏长');
  if (features.shortRatio >= 0.35) parts.push('短句/半句多');
  if (features.laughRatio >= 0.1) parts.push('爱用“哈哈哈”');
  if (features.questionRatio >= 0.15) parts.push('常反问');
  if (features.exclaimRatio >= 0.12) parts.push('爱用感叹号');
  if (features.emojiRatio >= 0.1) parts.push('常用表情');
  if (features.particleRatio >= 0.3) parts.push('语气词多');
  if (features.ellipsisRatio >= 0.08) parts.push('常带省略号');
  return parts.length ? parts.join('；') : '表达比较平实';
}

/** 画像变化幅度（0~1），用于防抖。 */
export function styleDistance(previous, next) {
  if (!previous || !previous.features) return 1;
  const a = previous.features;
  const b = next || {};
  const rel = (x, y) => Math.abs((Number(y) || 0) - (Number(x) || 0)) / Math.max(1, Math.abs(Number(x) || 0));
  const ratios = ['shortRatio', 'laughRatio', 'questionRatio', 'exclaimRatio', 'emojiRatio', 'particleRatio'];
  const ratioDiff = Math.max(0, ...ratios.map((k) => Math.abs((Number(b[k]) || 0) - (Number(a[k]) || 0))));
  return Math.max(rel(a.avgLen, b.avgLen), ratioDiff);
}

/**
 * 是否采纳新样本生成候选画像。
 * @returns {{update:boolean, reason:string, distance?:number}}
 */
export function shouldUpdateStyle(profile, features, config = STYLE_DEFAULTS, now = Date.now()) {
  const cfg = { ...STYLE_DEFAULTS, ...(config || {}) };
  if (!features || features.sampleCount < cfg.minSamples) {
    return { update: false, reason: `样本不足（${features?.sampleCount || 0}/${cfg.minSamples}）` };
  }
  const spanHours = features.firstAt && features.lastAt ? (features.lastAt - features.firstAt) / 3600000 : 0;
  if (spanHours < cfg.minSpanHours) {
    return { update: false, reason: `时间跨度不足（${Math.round(spanHours)}h/${cfg.minSpanHours}h）` };
  }
  if (profile) {
    const updatedAt = Number(profile.updatedAt) || 0;
    if (updatedAt && now - updatedAt > cfg.freezeDays * 86400000) {
      return { update: false, reason: '画像已冻结（太久没新样本）' };
    }
    if (profile.status === 'frozen') return { update: false, reason: '画像被手动冻结' };
    const distance = styleDistance(profile, features);
    if (distance < cfg.minDistance) return { update: false, reason: `变化过小（${distance.toFixed(2)}）`, distance };
    return { update: true, reason: `变化 ${distance.toFixed(2)}`, distance };
  }
  return { update: true, reason: '首次生成' };
}

/** 生成新版本：只增不改，prev 保留最近 maxVersions 个。 */
export function mergeStyleProfile(profile, features, config = STYLE_DEFAULTS, now = Date.now()) {
  const cfg = { ...STYLE_DEFAULTS, ...(config || {}) };
  const version = (Number(profile?.version) || 0) + 1;
  const prev = Array.isArray(profile?.prev) ? [...profile.prev] : [];
  if (profile) {
    prev.push({
      version: Number(profile.version) || 0,
      summary: String(profile.summary || ''),
      features: profile.features || null,
      updatedAt: Number(profile.updatedAt) || 0
    });
    while (prev.length > cfg.maxVersions) prev.shift();
  }
  return {
    version,
    summary: buildStyleSummary(features),
    features,
    sampleCount: features.sampleCount,
    spanHours: features.firstAt && features.lastAt ? Math.round((features.lastAt - features.firstAt) / 3600000) : 0,
    status: 'active',
    updatedAt: now,
    prev
  };
}

/** 注入给模型的一行（样本不足时不注入）。 */
export function buildStyleLine(profile, config = STYLE_DEFAULTS) {
  const cfg = { ...STYLE_DEFAULTS, ...(config || {}) };
  if (!profile || profile.status === 'frozen') return '';
  if (cfg.inject === false) return '';
  if (Number(profile.sampleCount) < cfg.minSamples) return '';
  if (!profile.summary) return '';
  return `【本群说话习惯】${profile.summary}（样本 ${profile.sampleCount} 条）`;
}