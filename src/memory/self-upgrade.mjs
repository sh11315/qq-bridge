// 自升级提案 / 外部卡尺 —— 纯函数模块（无 fs / 无网络 / 无副作用）。
//
// 背景：v1.7 起允许机器人"自己给自己升级"，但升级必须过三道闸门：
//   1) 外部卡尺：语气/行为好坏由外部规则（SELF_RUBRIC）判定，自评永远只是"嫌疑"，
//      不是分数、更不是满分；真正算数的是主人的判定（externalScore 恒为 null）；
//   2) 提案制：扫描出的问题只变成候选提案（pending），主人批准后才生效；
//   3) 周回看：weeklyReview 每周回看最近说过的话，给控制台/主人一份可读的复盘。
//
// 本文件只做扫描、提案生成、归一化与周报组装；写 brain.json（brain.self.proposals）
// 与审批动作由 service / 控制台负责，这里绝不落盘。
//
// 所有函数都把 now 作为显式参数（默认 Date.now()），保证可复现、可回放、易测试。

import { createHash } from 'node:crypto';

export const DAY_MS = 86_400_000;
export const DEFAULT_SCAN_DAYS = 7;
export const MAX_PROPOSALS = 3;
export const MAX_EXAMPLES = 3;
export const EXAMPLE_TEXT_MAX = 80;
export const EVIDENCE_TEXT_MAX = 200;
export const EVIDENCE_LIMIT = 5;
export const TITLE_MAX = 200;
export const DETAIL_MAX = 800;

/** 提案类型：目前只有"语气/行为"一类，未来可加 persona/流程 等。 */
export const PROPOSAL_KINDS = Object.freeze(['tone']);
/** 提案状态白名单；只有 pending/approved 算"还开着"，用于去重。 */
export const PROPOSAL_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);
export const OPEN_PROPOSAL_STATUSES = Object.freeze(['pending', 'approved']);

/**
 * 外部卡尺：机器人说话/行为的红线规则。
 * 这些规则由外部写定，机器人不能自己改、也不能用自评替代；扫描结果只是"嫌疑"。
 *
 * 每条规则：{ id, label, desc, hints, minHits }
 * - hints：命中关键词（question-tails 按"以问号结尾"匹配，over-proactive 不用 hints）；
 * - minHits：窗口内命中数达到该值才算一个问题，避免偶发误报。
 */
export const SELF_RUBRIC = Object.freeze([
  Object.freeze({
    id: 'customer-service',
    label: '客服腔',
    desc: '回复里出现"希望对您有帮助 / 如有需要 / 随时告诉我"这类客服话术，听着像工单机器人而不是朋友。',
    hints: Object.freeze(['希望对您有帮助', '如有需要', '随时告诉我', '感谢您的', '亲', '呢~', '哦~']),
    minHits: 2,
  }),
  Object.freeze({
    id: 'question-tails',
    label: '问句收尾',
    desc: '回复总用问号收尾，像在采访或把话题硬推回去，不是自然聊天。',
    hints: Object.freeze(['？', '吗？', '呢？', '吧？']),
    minHits: 3,
  }),
  Object.freeze({
    id: 'over-proactive',
    label: '主动开口过多',
    desc: '最近一段时间主动发起对话的次数偏多，容易打扰到人。',
    hints: Object.freeze([]),
    minHits: 5,
  }),
]);

const RUBRIC_BY_ID = new Map(SELF_RUBRIC.map((rule) => [rule.id, rule]));

/** 所有提案 detail 都以这句话收尾：自评不算数，外部卡尺/主人说了算。 */
const SELF_SUSPICION_NOTE =
  '这只是机器人的自评嫌疑，不算数；外部卡尺以主人的判定为准，主人批准后才会变成生效的语气提示。';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** 归一化到 0..1 并保留三位小数。 */
function round3(value) {
  return Math.round(clamp(value, 0, 1) * 1000) / 1000;
}

function sha1(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex');
}

function toTimestamp(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 文本归一：压缩空白、去首尾；非字符串一律当空串。 */
function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

/** 扫描窗口天数：非法/非正数回落到 7 天。 */
function normalizeWindowDays(days) {
  const n = Math.floor(Number(days));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SCAN_DAYS;
}

/** 提案条数上限：非法/非正数回落到默认 3 条。 */
function normalizeMax(max) {
  const n = Math.floor(Number(max));
  return Number.isFinite(n) && n > 0 ? n : MAX_PROPOSALS;
}

/** 扫描分母（窗口内被扫描的条数）；非法按 0 处理。 */
function normalizeScanned(scanned) {
  const n = Math.floor(Number(scanned));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 分数归一：缺省/非法取 fallback；合法则夹到 0..1。 */
function normalizeScore(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, 0, 1) : fallback;
}

/**
 * 外部分归一：只允许 null 或 0..1 的数字。
 * 非法值一律退成 null —— 宁可"没有外部判定"，也绝不伪造一个外部分数。
 */
function normalizeExternalScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, 0, 1) : null;
}

/**
 * 收集扫描窗口内的条目。
 * 只保留文本非空、at 合法（0 < at <= now）、且在最近 days 天内的条目；
 * 未来时间/窗口外的旧数据都不参与扫描。
 */
function collectWindowItems(items, now, days) {
  const list = Array.isArray(items) ? items : [];
  const since = now - days * DAY_MS;
  const windowItems = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const text = normalizeText(item.text);
    const at = Number(item.at);
    if (!text || !Number.isFinite(at) || at <= 0) continue;
    if (at < since || at > now) continue;
    windowItems.push({
      text,
      at,
      kind: typeof item.kind === 'string' ? item.kind.trim().toLowerCase() : '',
    });
  }
  return windowItems;
}

function containsAnyHint(text, hints) {
  return hints.some((hint) => hint && text.includes(hint));
}

/** 问句收尾：以全角问号或半角问号结尾（hints 里都是全角，额外兼容半角）。 */
function hasQuestionTail(text) {
  const tail = text.trim();
  if (!tail) return false;
  return tail.endsWith('？') || tail.endsWith('?') || SELF_RUBRIC[1].hints.some((hint) => tail.endsWith(hint));
}

/** 从命中条目里挑最多 3 条原文做 examples（最新优先、去重），附带证据（含时间戳）。 */
function pickExamples(matched, limit = MAX_EXAMPLES) {
  const sorted = matched.slice().sort((a, b) => b.at - a.at);
  const seen = new Set();
  const examples = [];
  const evidence = [];
  for (const item of sorted) {
    const text = item.text.slice(0, EXAMPLE_TEXT_MAX);
    if (seen.has(text)) continue;
    seen.add(text);
    examples.push(text);
    evidence.push({ text: item.text.slice(0, EVIDENCE_TEXT_MAX), at: item.at });
    if (examples.length >= limit) break;
  }
  return { examples, evidence };
}

/**
 * 按单条规则扫描窗口条目，返回 { issue|null }。
 * 契约字段是 {rubricId,label,count,examples}；额外附 evidence [{text,at}] 给提案当证据。
 */
function evaluateRule(rule, windowItems, { proactiveCount } = {}) {
  let matched = [];
  let count = 0;

  if (rule.id === 'over-proactive') {
    // 主动开口次数由调用方（唤醒日志/service）传入；没传时退化为"kind=proactive 的条目数"。
    const provided = proactiveCount === null || proactiveCount === undefined ? NaN : Number(proactiveCount);
    if (Number.isFinite(provided) && provided >= 0) {
      count = Math.floor(provided);
    } else {
      matched = windowItems.filter((item) => item.kind === 'proactive');
      count = matched.length;
    }
    if (provided >= 0) {
      matched = windowItems.filter((item) => item.kind === 'proactive');
    }
  } else if (rule.id === 'question-tails') {
    matched = windowItems.filter((item) => hasQuestionTail(item.text));
    count = matched.length;
  } else {
    matched = windowItems.filter((item) => containsAnyHint(item.text, rule.hints));
    count = matched.length;
  }

  if (count < rule.minHits) return null;
  const { examples, evidence } = pickExamples(matched);
  return {
    rubricId: rule.id,
    label: rule.label,
    count,
    examples,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// 对外纯函数
// ---------------------------------------------------------------------------

/**
 * 扫描一段"自己说过的话"，按外部卡尺找出语气/行为问题。
 *
 * @param {Array<{text:string, at:number, kind?:string}>} items 待扫描条目（kind 可为 'proactive'）
 * @param {{now?:number, days?:number, proactiveCount?:number}} [options]
 *   now 显式传入便于测试；days 默认 7；proactiveCount 是窗口内主动开口次数
 *   （over-proactive 规则的输入，缺省时用 kind='proactive' 的条目数代替）。
 * @returns {{issues:Array<{rubricId:string,label:string,count:number,examples:string[]}>, scanned:number, windowDays:number}}
 */
export function scanToneIssues(items, { now = Date.now(), days = DEFAULT_SCAN_DAYS, proactiveCount } = {}) {
  const baseNow = toTimestamp(now, Date.now());
  const windowDays = normalizeWindowDays(days);
  const windowItems = collectWindowItems(items, baseNow, windowDays);
  const issues = [];
  for (const rule of SELF_RUBRIC) {
    const issue = evaluateRule(rule, windowItems, { proactiveCount });
    if (issue) issues.push(issue);
  }
  return { issues, scanned: windowItems.length, windowDays };
}

/** 归一化一条 issue（只接受带 rubricId 且 count>0 的条目）。 */
function normalizeIssue(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rubricId = typeof raw.rubricId === 'string' ? raw.rubricId.trim().slice(0, 80) : '';
  if (!rubricId) return null;
  const count = Math.max(0, Math.floor(Number(raw.count) || 0));
  if (count <= 0) return null;
  const label = normalizeText(raw.label) || RUBRIC_BY_ID.get(rubricId)?.label || rubricId;
  const rawExamples = Array.isArray(raw.examples) ? raw.examples : [];
  const examples = [];
  for (const example of rawExamples) {
    const text = normalizeText(typeof example === 'string' ? example : example && example.text).slice(0, EXAMPLE_TEXT_MAX);
    if (!text) continue;
    examples.push(text);
    if (examples.length >= MAX_EXAMPLES) break;
  }
  const evidence = [];
  const rawEvidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  for (const item of rawEvidence) {
    if (!item || typeof item !== 'object') continue;
    const text = normalizeText(item.text).slice(0, EVIDENCE_TEXT_MAX);
    if (!text) continue;
    evidence.push({ text, at: toTimestamp(item.at, 0) });
    if (evidence.length >= EVIDENCE_LIMIT) break;
  }
  if (!evidence.length) {
    for (const text of examples) evidence.push({ text: text.slice(0, EVIDENCE_TEXT_MAX), at: 0 });
  }
  return { rubricId, label, count, examples, evidence };
}

/** 生成稳定提案 id：同一 rubricId 在同一天内多次生成会重复，靠"已有 open 提案"去重。 */
function buildProposalId(rubricId, now) {
  return `prop_${rubricId.replace(/[^a-z0-9-]/gi, '') || 'tone'}_${now}`;
}

/** 面向主人审批的中文标题/详情模板（不出现数字满分，只描述想怎么改）。 */
const PROPOSAL_TEMPLATES = Object.freeze({
  'customer-service': Object.freeze({
    title: () => '以后少说客服话术',
    detail: ({ count, days }) =>
      `最近 ${days} 天有 ${count} 条回复带着客服腔（"希望对您有帮助""如有需要"这类话），听着像工单机器人。` +
      `想改成说人话：直接回应对方在意的点，少用敬语尾巴，不用每句都服务到位。${SELF_SUSPICION_NOTE}`,
  }),
  'question-tails': Object.freeze({
    title: () => '别总拿问句收尾',
    detail: ({ count, days }) =>
      `最近 ${days} 天有 ${count} 条回复以问号收尾，像在采访、把话题硬抛回去。` +
      `想改成：想接就接一句自己的看法，把话说完，别每句都反问。${SELF_SUSPICION_NOTE}`,
  }),
  'over-proactive': Object.freeze({
    title: () => '少主动开口，先等人来',
    detail: ({ count, days }) =>
      `最近 ${days} 天主动开口 ${count} 次，有点频繁，容易打扰到人。` +
      `想改成：没有由头时先安静待着，真想说话再开口，别为了存在感硬找话题。${SELF_SUSPICION_NOTE}`,
  }),
});

function templateFor(rubricId, label) {
  return (
    PROPOSAL_TEMPLATES[rubricId] || {
      title: () => `想改一下「${label}」`,
      detail: ({ count, days }) =>
        `最近 ${days} 天在「${label}」这条外部卡尺上被标出 ${count} 处嫌疑。想先改掉这个习惯。${SELF_SUSPICION_NOTE}`,
    }
  );
}

/**
 * 把扫描出的问题变成"送主人审批"的候选提案。
 *
 * 规则：
 * - 每个 issue 生成一条 kind='tone' 的 pending 提案，最多 max 条（默认 3）；
 * - 同 rubricId 已有 pending/approved 提案（还开着）时跳过，避免重复打扰主人；
 * - selfScore = issue.count / 扫描总数（0..1），只表示"自评嫌疑"，不是自评打分；
 * - externalScore 恒为 null：外部卡尺由主人判定，模块不伪造外部分。
 *
 * @param {{issues?:Array, existing?:Array, now?:number, max?:number, scanned?:number, days?:number,
 *          scan?:{issues?:Array, scanned?:number}}} [options]
 *   issues 可以是 scanToneIssues 的 issues 数组，也可以直接传整个 scan 结果对象；
 *   scanned 建议传 scanToneIssues 返回的 scanned（自评分母），缺省时按 count 保守估计。
 * @returns {Array<object>} 提案数组（未持久化）
 */
export function buildProposals({ issues = [], existing = [], now = Date.now(), max = MAX_PROPOSALS, scanned = 0, days = DEFAULT_SCAN_DAYS, scan } = {}) {
  const baseNow = toTimestamp(now, Date.now());
  const daysNorm = normalizeWindowDays(days);
  const limit = normalizeMax(max);
  const explicitScan = scan && typeof scan === 'object' && !Array.isArray(scan) && Array.isArray(scan.issues) ? scan : null;
  const issuesAsScan = issues && typeof issues === 'object' && !Array.isArray(issues) && Array.isArray(issues.issues) ? issues : null;
  const scanLike = explicitScan || issuesAsScan;
  const issueList = scanLike ? scanLike.issues : Array.isArray(issues) ? issues : [];
  const scanTotal = normalizeScanned(scanned) || normalizeScanned(scanLike?.scanned);

  const openRubricIds = new Set();
  for (const raw of Array.isArray(existing) ? existing : []) {
    const proposal = normalizeProposal(raw, baseNow);
    if (proposal && proposal.rubricId && isProposalOpen(proposal)) openRubricIds.add(proposal.rubricId);
  }

  const proposals = [];
  for (const rawIssue of issueList) {
    if (proposals.length >= limit) break;
    const issue = normalizeIssue(rawIssue);
    if (!issue) continue;
    if (openRubricIds.has(issue.rubricId)) continue;
    openRubricIds.add(issue.rubricId); // 同批内同一个 rubricId 只提一条
    const template = templateFor(issue.rubricId, issue.label);
    // 自评嫌疑 = 问题条数 / 窗口内扫描总数；没有总数时按"全额嫌疑"保守记录。
    const denominator = scanTotal > 0 ? scanTotal : issue.count;
    const selfScore = round3(issue.count / Math.max(1, denominator));
    proposals.push({
      id: buildProposalId(issue.rubricId, baseNow),
      kind: 'tone',
      rubricId: issue.rubricId,
      title: template.title(issue),
      detail: template.detail({ count: issue.count, days: daysNorm, label: issue.label }).slice(0, DETAIL_MAX),
      evidence: issue.evidence.slice(0, EVIDENCE_LIMIT).map((item) => ({ text: item.text.slice(0, EVIDENCE_TEXT_MAX), at: item.at })),
      status: 'pending',
      createdAt: baseNow,
      decidedAt: null,
      by: null,
      selfScore,
      externalScore: null,
    });
  }
  return proposals;
}

/**
 * 归一化一条提案（与 model.mjs 的 normalizeSelf → brain.self.proposals 形状保持一致）。
 * 非法输入返回 null；非法状态归 pending；非法外部分归 null（绝不伪造外部判定）。
 *
 * @param {object|null} raw
 * @param {number} [now]
 * @returns {null|{id:string,kind:string,rubricId:string,title:string,detail:string,
 *   evidence:Array<{text:string,at:number}>,status:string,createdAt:number,
 *   decidedAt:number|null,by:string|null,selfScore:number,externalScore:number|null}}
 */
export function normalizeProposal(raw, now = Date.now()) {
  const baseNow = toTimestamp(now, Date.now());
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const title = normalizeText(raw.title).slice(0, TITLE_MAX);
  const detail = normalizeText(raw.detail).slice(0, DETAIL_MAX);
  if (!title && !detail) return null;

  const statusRaw = typeof raw.status === 'string' ? raw.status.trim() : '';
  const status = PROPOSAL_STATUSES.includes(statusRaw) ? statusRaw : 'pending';
  const kindRaw = typeof raw.kind === 'string' ? raw.kind.trim().slice(0, 40) : '';
  const kind = kindRaw || 'tone';
  const rubricId = typeof raw.rubricId === 'string' ? raw.rubricId.trim().slice(0, 80) : '';

  const evidence = [];
  for (const item of Array.isArray(raw.evidence) ? raw.evidence : []) {
    const text = normalizeText(typeof item === 'string' ? item : item && item.text).slice(0, EVIDENCE_TEXT_MAX);
    if (!text) continue;
    const at = item && typeof item === 'object' ? toTimestamp(item.at, 0) : 0;
    evidence.push({ text, at });
    if (evidence.length >= EVIDENCE_LIMIT) break;
  }

  const createdAt = toTimestamp(raw.createdAt, baseNow);
  const decidedAtNumber = toTimestamp(raw.decidedAt, 0);
  let by = null;
  if (typeof raw.by === 'string' && raw.by.trim()) by = raw.by.trim().slice(0, 80);

  const providedId = typeof raw.id === 'string' ? raw.id.trim().slice(0, 80) : '';
  const id = providedId || `prop_${sha1(`${kind}|${rubricId}|${title}|${createdAt}`).slice(0, 12)}`;

  return {
    id,
    kind,
    rubricId,
    title,
    detail,
    evidence,
    status,
    createdAt,
    decidedAt: decidedAtNumber > 0 ? decidedAtNumber : null,
    by,
    selfScore: normalizeScore(raw.selfScore, 0),
    externalScore: normalizeExternalScore(raw.externalScore),
  };
}

/** 提案是否"还开着"（pending/approved）——用于避免重复提案。 */
export function isProposalOpen(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return false;
  const status = typeof proposal.status === 'string' ? proposal.status.trim() : '';
  return OPEN_PROPOSAL_STATUSES.includes(status);
}

/** 语气漂移：平均长度、问句收尾率、客服腔命中率（0..1，保留三位小数）。 */
function computeDrift(windowItems) {
  const scanned = windowItems.length;
  if (!scanned) return { avgLen: 0, questionTailRate: 0, serviceToneRate: 0 };
  const serviceHints = RUBRIC_BY_ID.get('customer-service')?.hints ?? [];
  let totalLen = 0;
  let questionTails = 0;
  let serviceTones = 0;
  for (const item of windowItems) {
    totalLen += item.text.length;
    if (hasQuestionTail(item.text)) questionTails += 1;
    if (containsAnyHint(item.text, serviceHints)) serviceTones += 1;
  }
  return {
    avgLen: Math.round(totalLen / scanned),
    questionTailRate: round3(questionTails / scanned),
    serviceToneRate: round3(serviceTones / scanned),
  };
}

/**
 * 每周自我审视：扫描 + 生成提案 + 语气漂移 + 一个"自评嫌疑总览"。
 * 注意 externalScore 恒为 null：复盘结论要等主人用外部卡尺判定。
 *
 * @param {{items?:Array, existing?:Array, now?:number, proactiveCount?:number,
 *          days?:number, max?:number}} [options]
 * @returns {{ok:boolean, scan:object, proposals:object[], drift:{avgLen:number,questionTailRate:number,serviceToneRate:number}, selfScore:number, externalScore:null}}
 */
export function weeklyReview({ items = [], existing = [], now = Date.now(), proactiveCount, days = DEFAULT_SCAN_DAYS, max = MAX_PROPOSALS } = {}) {
  const baseNow = toTimestamp(now, Date.now());
  const windowDays = normalizeWindowDays(days);
  const windowItems = collectWindowItems(items, baseNow, windowDays);
  const scan = scanToneIssues(items, { now: baseNow, days: windowDays, proactiveCount });
  const proposals = buildProposals({
    issues: scan.issues,
    existing,
    now: baseNow,
    max,
    scanned: scan.scanned,
    days: windowDays,
  });
  const drift = computeDrift(windowItems);
  const totalHits = scan.issues.reduce((sum, issue) => sum + issue.count, 0);
  const selfScore = round3(totalHits / Math.max(1, scan.scanned));
  return {
    ok: true,
    scan,
    proposals,
    drift,
    selfScore,
    externalScore: null,
  };
}
