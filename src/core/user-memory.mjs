// 跨群用户记忆 + 四维关系（纯函数）。
//
// 参照 astrbot_plugin_qq_user_memory 的「关系维度」：
//   · 以 QQ 号为主键，跨群/私聊共享同一份关系（群氛围不写进个人关系）；
//   · 熟悉/信任/亲近/默契四个方向各自演进，按半衰期自然回落；
//   · 熟悉/默契靠发言量与互动轮次的饱和曲线长出来（上限 92/90，不给 100）；
//   · 边界（称呼禁忌/偏好、敏感话题、玩笑、肉麻）必须重复出现 2 次才确认；
//   · 只影响“怎么跟这个人说话”，不换算成服从度。
//
// 只存数值与短句，不存消息原文；原文检索由 history 模块负责。

// 截断必须按码点走：slice 会切在 emoji 代理对中间，留下孤立代理（写进提示词后渲染成 �）。
import { truncateText } from '../md-to-plain.js';

export const USER_MEMORY_DEFAULTS = Object.freeze({
  familiarityHalfLifeDays: 45,
  trustHalfLifeDays: 120,
  closenessHalfLifeDays: 30,
  rapportHalfLifeDays: 60,
  familiarityCap: 92,
  rapportCap: 90,
  maxBoundaries: 20,
  boundaryConfirmHits: 2
});

const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, Number(value) || 0));
const daysBetween = (from, to) => Math.max(0, (Number(to) - Number(from)) / 86400000);

export function emptyProfile(qq, now = Date.now()) {
  return {
    qq: String(qq ?? ''),
    nick: '',
    familiarity: 0,
    trust: 48,
    closeness: 20,
    rapport: 0,
    interactions: 0,
    messageCount: 0,
    groups: [],
    scenes: {},
    boundaries: [],
    lastSeenAt: 0,
    createdAt: now,
    updatedAt: now
  };
}

/** 发言量 → 熟悉/默契的种子（饱和曲线，1600 条与 5500 条不该同分）。 */
export function messageSeed(messageCount, cap) {
  return cap * (1 - Math.exp(-Math.max(0, Number(messageCount) || 0) / 1500));
}

/** 长期不聊时按半衰期回落；发言量不衰减，回来聊一句会重新靠近种子。 */
export function decayProfile(profile, now = Date.now()) {
  if (!profile) return null;
  const days = daysBetween(profile.updatedAt || now, now);
  if (days < 1) return { ...profile };
  const d = (value, baseline, halfLifeDays) => baseline + ((Number(value) || 0) - baseline) * Math.pow(0.5, days / halfLifeDays);
  return {
    ...profile,
    familiarity: clamp(d(profile.familiarity, 0, USER_MEMORY_DEFAULTS.familiarityHalfLifeDays)),
    trust: clamp(d(profile.trust, 48, USER_MEMORY_DEFAULTS.trustHalfLifeDays)),
    closeness: clamp(d(profile.closeness, 20, USER_MEMORY_DEFAULTS.closenessHalfLifeDays)),
    rapport: clamp(d(profile.rapport, 0, USER_MEMORY_DEFAULTS.rapportHalfLifeDays)),
    updatedAt: now
  };
}

const POSITIVE_RE = /谢谢|喜欢你|厉害|真好|辛苦|可爱|靠谱|信任你/;
const NEGATIVE_RE = /滚|闭嘴|烦死|讨厌你|别烦|傻[逼比]|无语/;

/** 一条入站消息对关系的增量（就地返回新对象）。 */
export function applyMessage(profile, input = {}, now = Date.now()) {
  const base = decayProfile(profile || emptyProfile(input.userId, now), now);
  const text = String(input.text ?? '');
  const next = { ...base };
  next.messageCount = (Number(base.messageCount) || 0) + 1;
  next.interactions = (Number(base.interactions) || 0) + 1;
  // “私聊/群聊”是 bridge 给的占位 sender，不是昵称；别把它写进关系档案。
  const nick = truncateText(String(input.nick ?? '').trim(), 40);
  if (nick && !/^(私聊|群聊|未知|群友)$/.test(nick)) next.nick = nick;
  next.lastSeenAt = now;

  // 熟悉：向消息量种子靠近，每条只挪一小步（越熟越难涨）
  const familiarityTarget = messageSeed(next.messageCount, USER_MEMORY_DEFAULTS.familiarityCap);
  next.familiarity = clamp(base.familiarity + Math.max(0, familiarityTarget - base.familiarity) * 0.18);

  // 默契：靠互动轮次，节奏比熟悉慢
  const rapportTarget = messageSeed(next.interactions, USER_MEMORY_DEFAULTS.rapportCap);
  next.rapport = clamp(base.rapport + Math.max(0, rapportTarget - base.rapport) * 0.12);

  // 亲近：正面互动推高、负面压低，掉得最快（读取时还会按半衰期回落）
  next.closeness = clamp(base.closeness + (POSITIVE_RE.test(text) ? 1.2 : 0) - (NEGATIVE_RE.test(text) ? 1.8 : 0));

  // 信任：最难建立也最难失去，只被低权重牵动
  next.trust = clamp(base.trust + 0.03);

  const scene = String(input.key ?? '');
  if (scene) {
    const cur = base.scenes?.[scene] || { count: 0, lastAt: 0 };
    next.scenes = { ...base.scenes, [scene]: { count: (Number(cur.count) || 0) + 1, lastAt: now } };
    if (scene.startsWith('group:')) {
      const gid = scene.slice(6);
      if (gid && !next.groups.includes(gid)) next.groups = [...next.groups, gid].slice(-20);
    }
  }
  next.updatedAt = now;
  return next;
}

const BOUNDARY_RULES = [
  { kind: 'name_forbidden', re: /别(?:再)?叫我\s*([^\s，。,.!?！？~]{1,10})/ },
  { kind: 'name_forbidden', re: /不要叫我\s*([^\s，。,.!?！？~]{1,10})/ },
  { kind: 'name_preferred', re: /叫我\s*([^\s，。,.!?！？~]{1,10})(?:就|吧)/ },
  { kind: 'topic_sensitive', re: /别(?:再)?聊\s*([^\s，。,.!?！？~]{1,12})/ },
  { kind: 'joke_off', re: /别开(?:我)?玩笑|不喜欢.{0,4}玩笑/ },
  { kind: 'joke_ok', re: /可以(?:拿我|跟我)?开.{0,4}玩笑/ },
  { kind: 'warm_off', re: /别肉麻|不喜欢肉麻/ },
  { kind: 'warm_ok', re: /可以肉麻|不介意肉麻/ }
];

/** 从一句话里识别候选边界（同一条要后续再次出现才确认）。 */
export function detectBoundaries(text) {
  const source = String(text ?? '');
  const out = [];
  for (const { kind, re } of BOUNDARY_RULES) {
    const match = source.match(re);
    if (!match) continue;
    const raw = String(match[1] || match[0]).trim().replace(/[“”"'‘’]/g, '');
    if (!raw) continue;
    if (!out.some((b) => b.kind === kind && b.text === raw)) out.push({ kind, text: truncateText(raw, 20) });
  }
  return out;
}

/** 记录候选边界：同 kind+text 第 2 次出现才置 confirmedAt。 */
export function recordBoundaries(profile, text, now = Date.now()) {
  const candidates = detectBoundaries(text);
  if (!candidates.length) return profile;
  const existing = Array.isArray(profile.boundaries) ? [...profile.boundaries] : [];
  for (const candidate of candidates) {
    const at = existing.findIndex((b) => b && b.kind === candidate.kind && b.text === candidate.text);
    if (at >= 0) {
      const hit = { ...existing[at], hits: (Number(existing[at].hits) || 1) + 1 };
      if (hit.hits >= USER_MEMORY_DEFAULTS.boundaryConfirmHits && !hit.confirmedAt) hit.confirmedAt = now;
      existing[at] = hit;
    } else {
      existing.push({ ...candidate, hits: 1, confirmedAt: 0 });
    }
  }
  return {
    ...profile,
    boundaries: existing.slice(-USER_MEMORY_DEFAULTS.maxBoundaries),
    updatedAt: now
  };
}

const TIERS = {
  familiarity: [[85, '老朋友了'], [65, '挺熟'], [40, '一般认识'], [0, '不太熟']],
  trust: [[85, '信得过'], [65, '比较信任'], [40, '还在观察'], [0, '不太确定']],
  closeness: [[85, '很随意'], [65, '挺亲近'], [40, '客客气气'], [0, '有点距离']],
  rapport: [[85, '合拍'], [65, '聊得来'], [40, '刚接触'], [0, '还接不上']]
};

export function relationshipWords(profile) {
  const pick = (field) => (TIERS[field].find(([min]) => Number(profile?.[field] ?? 0) >= min) || TIERS[field][TIERS[field].length - 1])[1];
  return {
    familiarity: pick('familiarity'),
    trust: pick('trust'),
    closeness: pick('closeness'),
    rapport: pick('rapport')
  };
}

const BOUNDARY_LABELS = {
  name_forbidden: (text) => `别叫“${text}”`,
  name_preferred: (text) => `习惯被叫“${text}”`,
  topic_sensitive: (text) => `不聊“${text}”`,
  joke_off: () => '不吃调侃',
  joke_ok: () => '接受调侃',
  warm_off: () => '不喜欢肉麻',
  warm_ok: () => '不排斥亲近'
};

/** 给模型读的一行（只给档位词与已确认边界，不给分数、不给别人信息）。 */
export function formatUserMemoryHint(profile) {
  if (!profile || !profile.qq) return '';
  const words = relationshipWords(profile);
  const nick = /^(私聊|群聊|未知|群友)$/.test(String(profile.nick ?? '').trim()) ? '' : String(profile.nick ?? '').trim();
  const who = nick ? `${nick}（QQ ${profile.qq}）` : `QQ ${profile.qq}`;
  const parts = [
    `熟悉：${words.familiarity}`,
    `信任：${words.trust}`,
    `亲近：${words.closeness}`,
    `默契：${words.rapport}`
  ];
  const boundaries = (Array.isArray(profile.boundaries) ? profile.boundaries : [])
    .filter((b) => b && b.confirmedAt)
    .slice(-5)
    .map((b) => (BOUNDARY_LABELS[b.kind] ? BOUNDARY_LABELS[b.kind](b.text) : ''))
    .filter(Boolean);
  return `【对这个人】${who}：${parts.join('｜')}${boundaries.length ? `；边界：${boundaries.join('、')}` : ''}`;
}