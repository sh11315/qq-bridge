/**
 * 跨功能会话的「上一轮结论」摘要（纯逻辑）。
 *
 * 背景：QQ 机器人的能力被拆成五套独立 DSH 会话（chat / sticker / vision / voice / web），
 * 它们共享最近消息快照 / 记忆 / 黑话库，但**工具调用历史互不共享**。
 * 于是从聊天切到看图（或反过来）时，新会话只看到群消息，不知道上一轮自己刚得出了什么
 * 结论、查到了什么资料 —— 模型常要重新跑一遍工具，白白多烧一轮 token。
 *
 * 这里只做一行文字的归一化与拼接：
 *   · 每条回合结束时，把「结论」压成一行（最多 TURN_SUMMARY_MAX_CHARS 字）；
 *   · 下一次切到**不同功能**的会话时，把这一行带进新会话的快照；
 *   · 同一功能内部连续多轮**不重复注入**（那不是跨会话，上下文本来就在）。
 *
 * 安全/预算约束：
 *   · 只取一行、有硬上限，避免把整段回复塞进新 prompt 把上下文撑爆；
 *   · 摘要来自模型自己的输出/已发出的消息，不是外部输入，不会成为新的指令通道；
 *   · 调用方负责在发送前做敏感信息审计（bridge 的 redact/audit 仍然生效）。
 */

/** 摘要正文的硬上限（字符，按码点计，不会切出半个 emoji）。 */
export const TURN_SUMMARY_MAX_CHARS = 160;

/** 写进提示词的标记前缀：让模型一眼看出这不是群友的新消息。 */
export const TURN_SUMMARY_MARKER = '上轮结论：';

/**
 * 归一化一段摘要正文：
 *   · 去掉内部标记 [SILENT] 与常见 Markdown 装饰（**、`、# 标题符），保持一行；
 *   · 换行/连续空白压成单个空格；
 *   · 按码点截断到 maxChars，超出时补省略号；
 *   · 已经带「上轮结论：」前缀时去重，避免二次注入变成双前缀。
 */
export function normalizeTurnSummaryText(raw, maxChars = TURN_SUMMARY_MAX_CHARS) {
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) >= 1
    ? Math.floor(Number(maxChars))
    : TURN_SUMMARY_MAX_CHARS;
  let text = String(raw ?? '')
    // 控制字符（保留换行/制表，后面统一压空白）
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\[SILENT\]/gi, ' ')
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*/u, '')
    .replace(/\s*```\s*$/u, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.startsWith(TURN_SUMMARY_MARKER)) text = text.slice(TURN_SUMMARY_MARKER.length).trim();
  if (!text) return '';
  const chars = Array.from(text);
  if (chars.length > limit) {
    // 留一个字符给省略号，保证总长不超过 limit。
    return `${chars.slice(0, Math.max(1, limit - 1)).join('')}…`;
  }
  return text;
}

/**
 * 把本回合调用过的工具压成一句短说明（去掉 MCP 前缀，最多列 6 个）。
 * 只在「没有正文/没发出消息」时兜底，让新会话至少知道上一轮做过什么。
 */
export function summarizeToolNames(toolNames, max = 6) {
  const list = (Array.isArray(toolNames) ? toolNames : [])
    .map((name) => String(name ?? '').trim())
    .filter(Boolean)
    .map((name) => {
      const idx = name.lastIndexOf('__');
      // mcp__snowluma__qq_send_message → qq_send_message；普通工具名原样保留。
      const short = idx >= 0 ? name.slice(idx + 2) : name;
      return short.replace(/^mcp__/, '');
    })
    .filter(Boolean);
  const unique = [...new Set(list)];
  if (!unique.length) return '';
  const shown = unique.slice(0, Math.max(1, Math.floor(Number(max) || 6)));
  return shown.join('、') + (unique.length > shown.length ? ` 等 ${unique.length} 个工具` : '');
}

/**
 * 生成一条「上一轮结论」。
 *
 * 取值优先级：
 *   1. 回合正文（模型本轮的最终输出，通常是真正的结论）；
 *   2. 本轮实际发出的最后一条消息（reserved2 常用工具发言，正文可能为空）；
 *   3. 本轮调用过的工具名（连消息都没发时，至少告诉新会话"上一轮在做什么"）。
 *
 * @param {{text?: string, sentText?: string, toolNames?: string[], maxChars?: number}} input
 * @returns {string} 一行摘要；没有可用信息时返回空串。
 */
export function buildTurnSummary({ text, sentText, toolNames, maxChars = TURN_SUMMARY_MAX_CHARS } = {}) {
  const direct = normalizeTurnSummaryText(text, maxChars);
  if (direct) return direct;
  const sent = normalizeTurnSummaryText(sentText, maxChars);
  if (sent) return sent;
  const tools = summarizeToolNames(toolNames);
  return tools ? `本轮调用了 ${tools}` : '';
}

/**
 * 跨会话注入行：只在**功能域发生变化**时返回内容。
 *
 * @param {{feature?: string, text?: string}|null} prev 上一轮摘要（{feature,text}）
 * @param {string} nextFeature 本回合要进入的功能域（chat/sticker/vision/voice/web）
 * @param {Record<string,string>} labels 功能域中文名（bridge 传 FEATURE_LABELS）
 * @returns {string} 形如「【上轮结论 · 来自聊天会话】……」；不满足条件时返回空串。
 */
export function buildCrossSessionLine(prev, nextFeature, labels = {}, maxChars = TURN_SUMMARY_MAX_CHARS) {
  const feature = String(prev?.feature ?? '').trim();
  const next = String(nextFeature ?? '').trim();
  const body = normalizeTurnSummaryText(prev?.text, maxChars);
  if (!feature || !body || !next || feature === next) return '';
  const label = String(labels?.[feature] ?? '').trim() || feature;
  return `【上轮结论 · 来自${label}会话】${body}`;
}
