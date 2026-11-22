// 秘书旁路（纯逻辑）：主模型开口前，用轻量模型判断“这轮要不要接”。
//
// 参照 astrbot_plugin_angel_heart 的「前台 → 秘书 → 助理」三段式：
//   · 点名类唤醒（@/名字/提问/拍一拍/私聊/管理员）永远不经过秘书；
//   · 秘书只看最近几条消息，输出 {reply:boolean}，不做回复；
//   · 服务不可用/解析失败 → 默认放行（fail-open），宁可怕吵，不可漏回。
//
// 这里只放纯函数；网络调用与预算在 bridge 里。

// 截断必须按码点走：slice 会切在 emoji 代理对中间，留下孤立代理（显示成 �）。
import { truncateText } from '../md-to-plain.js';

export const DEFAULT_SECRETARY = Object.freeze({
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  timeoutMs: 20000,
  maxCallsPerHour: 120,
  maxDeferMs: 900000
});

export const SECRETARY_PROMPT = [
  '你是群聊的“要不要接话”秘书。只判断这一轮是否需要主模型开口，不要写回复。',
  '需要接：有人明确提问/求助、点名或叫外号、话题明显在等回应、对方在讲需要安慰的事。',
  '不需要接：纯灌水/表情/符号、别人之间的对口相声、广告或刷屏、和你无关的闲聊、重复内容。',
  '只输出 JSON，不要解释：{"reply":true 或 false,"reason":"不超过 20 字"}'
].join('\n');

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function normalizeSecretaryConfig(raw = {}) {
  const merged = { ...DEFAULT_SECRETARY, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    ...merged,
    enabled: merged.enabled === true,
    baseUrl: String(merged.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(merged.apiKey || '').trim(),
    model: String(merged.model || '').trim(),
    timeoutMs: clampInt(merged.timeoutMs, 3000, 120000, DEFAULT_SECRETARY.timeoutMs),
    maxCallsPerHour: clampInt(merged.maxCallsPerHour, 1, 2000, DEFAULT_SECRETARY.maxCallsPerHour),
    maxDeferMs: clampInt(merged.maxDeferMs, 60000, 86400000, DEFAULT_SECRETARY.maxDeferMs)
  };
}

/** 是否需要咨询秘书（点名类/私聊/无未读 → 不咨询）。 */
export function shouldConsult(input = {}) {
  if (input.enabled !== true) return { consult: false, reason: 'disabled' };
  if (input.directWake === true) return { consult: false, reason: 'direct' };
  if (String(input.key ?? '').startsWith('private:')) return { consult: false, reason: 'private' };
  if (!input.hasUnread) return { consult: false, reason: 'no-unread' };
  return { consult: true, reason: '' };
}

/** 最近消息 → 紧凑文本（不把整库喂过去）。 */
export function buildSecretaryDigest(messages, maxMessages = 8) {
  const list = Array.isArray(messages) ? messages.slice(-Math.max(1, maxMessages)) : [];
  return list.map((msg) => {
    const who = msg.isSelf ? '我' : (String(msg.sender || '').trim() || '群友');
    const text = truncateText(String(msg.text ?? '').replace(/\s+/g, ' '), 80);
    return `- ${who}：${text}`;
  }).join('\n');
}

export function buildSecretaryRequest(context = {}, config = DEFAULT_SECRETARY) {
  const digest = buildSecretaryDigest(context.messages);
  return {
    url: `${String(config.baseUrl).replace(/\/+$/, '')}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          { role: 'system', content: SECRETARY_PROMPT },
          { role: 'user', content: `群聊最近消息：\n${digest || '（无）'}\n本轮唤醒原因：${context.reason || '未知'}` }
        ]
      })
    }
  };
}

/**
 * 解析秘书输出。解析失败/字段缺失 → 放行（fail-open），并标记 fallback。
 * @returns {{allow:boolean, reason:string, fallback?:boolean}}
 */
export function parseSecretaryVerdict(text) {
  const raw = String(text ?? '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return { allow: true, reason: '解析失败，默认放行', fallback: true };
  let parsed = null;
  try { parsed = JSON.parse(candidate.slice(start, end + 1)); } catch { return { allow: true, reason: '解析失败，默认放行', fallback: true }; }
  const value = typeof parsed.reply === 'boolean' ? parsed.reply : (typeof parsed.allow === 'boolean' ? parsed.allow : null);
  if (value === null) return { allow: true, reason: '缺少 reply 字段，默认放行', fallback: true };
  return { allow: value, reason: truncateText(parsed.reason || (value ? '需要接话' : '不需要接话'), 60) };
}