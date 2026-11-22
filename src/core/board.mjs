// 会话共用小黑板（cross-session scratchpad）。
//
// 背景（2026-10-29 用户反馈）：
//   功能会话把同一 QQ 会话拆成 chat / sticker / vision / voice / web 多套 DSH 上下文，
//   于是「看图那边已经知道外面下雪了，聊天这边还在问今天冷不冷」——两路各说各的。
//   记忆（qq_memory_*）是长期的、按类别归类的；最近消息快照只覆盖最近几条。
//   这里补一块**短期、跨会话共享**的黑板：谁看见什么先写一条，另一路回答前先扫一眼。
//
// 设计取舍：
//   · 按 QQ 会话 key 存（group:/private:），同一 QQ 会话的所有功能会话共享同一块板。
//   · 短期：默认 6 小时过期（天气/今天加班这类事实只在这段时间内有用）；
//     长期事实应该进 qq_memory_append，两边分工写进提示词。
//   · 有上限：每块板最多 24 条，单条 200 字；注入提示词时只带最近 8 条，
//     避免小黑板本身变成上下文噪音。
//   · 纯函数实现（内存结构 + 格式化），落盘由 bridge 负责，便于单测。

/** 默认保留时长：6 小时。 */
export const BOARD_DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
/** 每块板最多保留的条数（落盘）。 */
export const BOARD_DEFAULT_MAX = 24;
/** 注入提示词时最多展示的条数。 */
export const BOARD_PROMPT_ENTRIES = 8;
/** 单条最多字数。 */
export const BOARD_MAX_TEXT = 200;

/** 功能会话 → 人类可读标签（写板时标来源，注入时也更好懂）。 */
export const BOARD_SOURCE_LABELS = Object.freeze({
  chat: '聊天',
  sticker: '表情',
  vision: '看图',
  voice: '语音',
  web: '联网',
});

/** 把任意来源（feature 名 / 中文标签 / 空）归一成简短标签。 */
export function boardSourceLabel(by) {
  const raw = String(by ?? '').trim();
  if (!raw) return '未知';
  const key = raw.toLowerCase();
  if (BOARD_SOURCE_LABELS[key]) return BOARD_SOURCE_LABELS[key];
  // 允许传 "vision:advanced" 这种 variant
  const head = key.split(/[:\s]/)[0];
  if (BOARD_SOURCE_LABELS[head]) return BOARD_SOURCE_LABELS[head];
  return raw.slice(0, 12);
}

/** 单条文本裁剪：去掉换行、压缩空白、超长截断。 */
export function clipBoardText(text, max = BOARD_MAX_TEXT) {
  const flat = String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!flat) return '';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 归一化整个 store 文件结构。 */
export function normalizeBoardStore(raw) {
  const out = { version: 1, updatedAt: 0, boards: {} };
  if (!raw || typeof raw !== 'object') return out;
  const boards = raw.boards && typeof raw.boards === 'object' ? raw.boards : {};
  for (const [key, list] of Object.entries(boards)) {
    const k = String(key ?? '').trim();
    if (!k || !Array.isArray(list)) continue;
    const entries = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const text = clipBoardText(item.text);
      if (!text) continue;
      const at = Number(item.at);
      entries.push({
        at: Number.isFinite(at) && at > 0 ? at : 0,
        by: String(item.by ?? '').slice(0, 24),
        text,
      });
    }
    if (entries.length) out.boards[k] = entries;
  }
  const updatedAt = Number(raw.updatedAt);
  out.updatedAt = Number.isFinite(updatedAt) ? updatedAt : 0;
  return out;
}

/** 过期淘汰 + 超量淘汰（保留最新的 max 条，按时间升序返回）。 */
export function pruneBoardEntries(list, { now = Date.now(), ttlMs = BOARD_DEFAULT_TTL_MS, max = BOARD_DEFAULT_MAX } = {}) {
  if (!Array.isArray(list)) return [];
  const cutoff = now - Math.max(60_000, Number(ttlMs) || BOARD_DEFAULT_TTL_MS);
  const kept = list
    .filter((e) => e && typeof e === 'object' && clipBoardText(e.text))
    .filter((e) => {
      const at = Number(e.at) || 0;
      // 没有时间戳的条目视为新写入（老文件兼容），保留
      return !at || at >= cutoff;
    })
    .map((e) => ({ at: Number(e.at) || 0, by: String(e.by ?? ''), text: clipBoardText(e.text) }));
  const limit = Math.max(1, Number(max) || BOARD_DEFAULT_MAX);
  return kept.slice(-limit);
}

/** 追加一条（自动淘汰旧条目）。返回新的列表。 */
export function appendBoardEntry(list, { text, by = '', at = Date.now() } = {}, opts = {}) {
  const clean = clipBoardText(text);
  if (!clean) return pruneBoardEntries(list, opts);
  const next = [...(Array.isArray(list) ? list : []), { at: Number(at) || Date.now(), by: String(by ?? '').slice(0, 24), text: clean }];
  return pruneBoardEntries(next, opts);
}

/** 删除一条（index 从 0 开始，对**展示顺序**即时间升序）；index 非法返回原列表。 */
export function removeBoardEntry(list, index, opts = {}) {
  const arr = pruneBoardEntries(list, opts);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= arr.length) return arr;
  arr.splice(i, 1);
  return arr;
}

/** HH:MM，跨天时带「昨天/前天」。 */
export function boardTimeLabel(at, now = Date.now()) {
  const ms = Number(at) || 0;
  if (!ms) return '--:--';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const dayDiff = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86_400_000);
  if (dayDiff === 0) return `${hh}:${mm}`;
  if (dayDiff === 1) return `昨天 ${hh}:${mm}`;
  if (dayDiff === 2) return `前天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/**
 * 生成注入唤醒提示词的「共用小黑板」段落。
 * 返回 '' 表示这块板没有可用内容且不需要提示（enabled=false 时）。
 */
export function formatBoardForPrompt(entries, { now = Date.now(), maxEntries = BOARD_PROMPT_ENTRIES, ttlMs = BOARD_DEFAULT_TTL_MS } = {}) {
  const kept = pruneBoardEntries(entries, { now, ttlMs, max: Math.max(maxEntries, BOARD_DEFAULT_MAX) });
  if (!kept.length) {
    return '【共用小黑板】这个 QQ 会话的所有功能会话（聊天/看图/表情/语音/联网）共用一块小黑板，目前还是空的。\n你确认了跨会话都用得上的事实（天气、约定、对方状态、正在做的事、已经查到的结论）时，用 qq_board_write 记一条，另一路回答前会先看到；别记流水账。\n\n';
  }
  const shown = kept.slice(-Math.max(1, Number(maxEntries) || BOARD_PROMPT_ENTRIES));
  const lines = shown.map((e) => `- ${boardTimeLabel(e.at, now)} ${boardSourceLabel(e.by)}｜${e.text}`);
  return `【共用小黑板·本会话】所有功能会话（聊天/看图/表情/语音/联网）共用，回答前先扫一眼，别两路各说各的：\n${lines.join('\n')}\n用 qq_board_write 记新的跨会话事实（天气/约定/对方状态/正在做的事/已查到的结论）；过时或写错的用 qq_board_forget 删掉。\n\n`;
}
