// DSH 事件契约监控（纯函数）：统计 session/event 类型，未知类型单独计数，
// 每 N 秒输出一次摘要，让“DSH 改了事件名”能在 bridge.log 里第一时间看到。
//
// 背景：2026-11-18 实测 DSH 0.2.x 的 prompt 回合只发 step/start（没有 turn/start），
// 导致 turn collector 静默丢文本、实时测试等到 120 秒超时。这类漂移不该再靠猜。

export const DEFAULT_EVENT_SUMMARY_MS = 60000;
export const KNOWN_EVENT_TYPES = Object.freeze([
  'turn/start', 'turn/end',
  'step/start', 'step/end',
  'assistant/chunk', 'assistant/message',
  'user/message', 'system/message',
  'request/header', 'request/context',
  'session/title', 'session/title-llm-request',
  'session/status', 'session/error',
  'model/selection',
  'tool/start', 'tool/end', 'tool/call', 'tool/result', 'tool/error'
]);
const KNOWN_PREFIXES = ['session-log-', 'command/', 'subagent/', 'agent/inbox/'];

export function isKnownDshEventType(type) {
  const value = String(type ?? '').trim();
  if (!value) return false;
  if (KNOWN_EVENT_TYPES.includes(value)) return true;
  return KNOWN_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * @param {{windowMs?:number, now?:()=>number, maxUnknown?:number}} [options]
 */
export function createDshEventMonitor(options = {}) {
  const windowMs = Math.max(0, Number(options.windowMs ?? DEFAULT_EVENT_SUMMARY_MS));
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxUnknown = Math.max(1, Number(options.maxUnknown) || 5);

  let windowStart = now();
  let counts = new Map();
  let unknown = new Map();

  const reset = () => {
    counts = new Map();
    unknown = new Map();
    windowStart = now();
  };

  const flush = () => {
    if (counts.size === 0) {
      windowStart = now();
      return null;
    }
    const summary = {
      windowMs: Math.max(0, now() - windowStart),
      counts: Object.fromEntries(counts),
      unknown: Object.fromEntries(unknown),
      total: [...counts.values()].reduce((a, b) => a + b, 0)
    };
    reset();
    return summary;
  };

  const record = (type) => {
    const value = String(type ?? '').trim() || 'unknown';
    counts.set(value, (counts.get(value) || 0) + 1);
    if (!isKnownDshEventType(value)) {
      // 采样上限只限制"记录哪些未知类型"，不能连带冻结已采样类型的计数。
      // 原来把两个语义压在同一个 `size < maxUnknown` 条件下：一旦窗口内出现
      // maxUnknown 个未知类型，已采样的类型也不再累加，日志会把成百次漂移
      // 显示成"偶发一次"，把最该被看见的信号压成噪声。
      if (unknown.has(value)) {
        unknown.set(value, unknown.get(value) + 1);
      } else if (unknown.size < maxUnknown) {
        unknown.set(value, 1);
      }
    }
    if (windowMs > 0 && now() - windowStart >= windowMs) return flush();
    return null;
  };

  const format = (summary) => {
    if (!summary) return '';
    const top = Object.entries(summary.counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([type, count]) => `${type}=${count}`)
      .join(' ');
    const unknowns = Object.entries(summary.unknown || {});
    const unknownText = unknowns.length
      ? `；未知：${unknowns.map(([type, count]) => `${type}×${count}`).join(', ')}`
      : '；未知：无';
    return `${Math.round(summary.windowMs / 1000)}s ${summary.total} 条：${top || '无'}${unknownText}`;
  };

  return { record, flush, format, isKnownDshEventType };
}