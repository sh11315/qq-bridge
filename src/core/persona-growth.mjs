// 人格自主成长（growth）护栏：把「自述 / 人设建议 / 语气提案」从「等主人批准」放宽为
// 「自己观察、自己提、自动采纳」，但仍然挡住会被滥用的几种输入。
//
// 设计取舍：
//   · 只做**纯函数**判定（不读盘、不发请求），真正的写入在 bridge 里走 memory service；
//   · 自动采纳的刹车有三道：单条字数上限、每天条数上限、两条之间的最小间隔；
//   · 明确拒绝网址、代码块、HTML 标签、命令行片段——这些东西写进「语气/人设」后会被
//     每回合注入，一旦被注入恶意内容影响面很大（提示词注入的常见载体）；
//   · 失败一律 skip（fail-closed），绝不因为判定异常而放行。
export const GROWTH_DEFAULTS = Object.freeze({
  enabled: true,
  autoApprove: true,
  maxPerDay: 3,
  maxChars: 160,
  minIntervalMs: 30 * 60_000,
});

const URL_RE = /https?:\/\/|www\./i;
const CODE_RE = /```|`[^`]{1,40}`|<\/?[a-z][\w-]*\s*\/?>/i;
const SHELL_RE = /(?:^|[\s（(])(?:pwsh|powershell|cmd|bash|sh|node|npm|pnpm|git|curl|wget|rm|del|reg|schtasks)\s/i;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** 压平空白、去掉控制字符、裁剪长度；返回空串表示这条不该被采纳。 */
export function sanitizeGrowthText(raw, maxChars = GROWTH_DEFAULTS.maxChars) {
  const limit = Math.max(8, Math.min(600, Number(maxChars) || GROWTH_DEFAULTS.maxChars));
  const text = String(raw ?? '')
    .replace(CONTROL_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.slice(0, limit);
}

/** 这条文本能不能被自动采纳（不是权限判定，只是内容安检）。 */
export function growthTextIsSafe(text) {
  const value = String(text ?? '');
  if (!value) return false;
  if (URL_RE.test(value)) return false;
  if (CODE_RE.test(value)) return false;
  if (SHELL_RE.test(value)) return false;
  // 全角/半角混排的长串英文多半是贴代码，直接挡掉。
  if (/[A-Za-z]{24,}/.test(value)) return false;
  return true;
}

/**
 * 自动采纳决策。
 * @param {object} input
 * @param {string} input.text      候选文本（未清洗也接受，内部会清洗）
 * @param {number} [input.approvedToday] 今天已自动采纳条数
 * @param {number} [input.lastApprovedAt] 上次自动采纳时间戳
 * @param {number} [input.now] 当前时间戳
 * @param {object} [input.options] 覆盖 GROWTH_DEFAULTS 的字段
 * @returns {{ok: boolean, reason: string, text: string}}
 */
export function decideAutoApprove({ text, approvedToday = 0, lastApprovedAt = 0, now = Date.now(), options = {} } = {}) {
  const cfg = { ...GROWTH_DEFAULTS, ...(options ?? {}) };
  if (cfg.enabled === false) return { ok: false, reason: 'growth-disabled', text: '' };
  if (cfg.autoApprove === false) return { ok: false, reason: 'auto-approve-off', text: '' };
  const value = sanitizeGrowthText(text, cfg.maxChars);
  if (!value) return { ok: false, reason: 'empty', text: '' };
  if (value.length < 4) return { ok: false, reason: 'too-short', text: '' };
  if (!growthTextIsSafe(value)) return { ok: false, reason: 'unsafe-content', text: '' };
  if (Number(approvedToday) >= Math.max(0, Number(cfg.maxPerDay) || 0)) return { ok: false, reason: 'daily-cap', text: '' };
  const gap = Math.max(0, Number(cfg.minIntervalMs) || 0);
  if (lastApprovedAt && now - Number(lastApprovedAt) < gap) return { ok: false, reason: 'cooldown', text: '' };
  return { ok: true, reason: 'ok', text: value };
}

/** 当天计数器的滚动重置（跨天归零）。 */
function localDayKey(now = Date.now()) {
  // 不依赖 Intl/locale（small-icu 的 Node 构建会让 toLocaleDateString('sv-SE') 静默变成非 ISO 格式，
  // 导致跨天分桶错乱）。用本地年月日手拼。
  const d = new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function rollDailyCounter(state = {}, now = Date.now()) {
  const day = localDayKey(now);
  const sameDay = String(state?.day ?? '') === day;
  return {
    day,
    approvedToday: sameDay ? Math.max(0, Number(state?.approvedToday) || 0) : 0,
    lastApprovedAt: Math.max(0, Number(state?.lastApprovedAt) || 0),
  };
}

/** 供日志/汇报用的单行摘要。 */
export function formatGrowthLog(input = {}) {
  const parts = [String(input.kind ?? 'growth'), String(input.decision ?? '')];
  if (input.reason) parts.push(`(${input.reason})`);
  if (input.text) parts.push(String(input.text).slice(0, 60));
  return parts.filter(Boolean).join(' ');
}
