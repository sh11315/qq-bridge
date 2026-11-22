// 表情入库的可选内容审核（默认关闭）。
//
// 与 astrbot_plugin_angel_smile_guard 的思路一致：入库前让多模态模型看一眼，
// 但不照搬它的「只允许女性角色」策略 —— 这里用通用规则（色情/暴力/违法/
// 不适内容/二维码广告/纯文字截图），并且提示词可被配置覆盖。
//
// 默认 fail-closed：审核开启但配置缺失/服务不可用/返回无法解析 → 拒绝入库。
// 想放宽可设 failOpen=true。

export const DEFAULT_REVIEW = Object.freeze({
  enabled: false,
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  timeoutMs: 60000,
  failOpen: false,
  prompt: ''
});

export const DEFAULT_REVIEW_PROMPT = [
  '你是表情包入库审核器。判断这张图是否适合放进日常聊天的表情库。',
  '拒绝：色情/明显性暗示、暴力血腥、违法内容、令人极度不适的画面、含二维码或广告、纯文字截图。',
  '允许：常见的搞笑动物、动漫角色、梗图、日常表情。',
  '只输出 JSON，不要解释：{"allow":true 或 false,"reason":"不超过 30 字"}'
].join('\n');

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function normalizeReviewConfig(raw = {}) {
  const merged = { ...DEFAULT_REVIEW, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    ...merged,
    enabled: merged.enabled === true,
    baseUrl: String(merged.baseUrl || DEFAULT_REVIEW.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: String(merged.apiKey || '').trim(),
    model: String(merged.model || '').trim(),
    timeoutMs: clampInt(merged.timeoutMs, 5000, 300000, DEFAULT_REVIEW.timeoutMs),
    failOpen: merged.failOpen === true,
    prompt: String(merged.prompt || '').trim() || DEFAULT_REVIEW_PROMPT
  };
}

function sniffMime(buffer) {
  if (!buffer || buffer.length < 12) return 'image/png';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/png';
}

export function buildReviewRequest(buffer, mime, config) {
  const type = mime || sniffMime(buffer);
  return {
    url: `${config.baseUrl}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          { role: 'system', content: config.prompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: '审核这张表情，按系统提示只输出 JSON。' },
              { type: 'image_url', image_url: { url: `data:${type};base64,${buffer.toString('base64')}` } }
            ]
          }
        ]
      })
    }
  };
}

function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

/**
 * @returns {Promise<{ok:boolean, skipped?:boolean, allow?:boolean, reason?:string}>}
 */
export async function reviewImage(buffer, mime, rawConfig, deps = {}) {
  const config = normalizeReviewConfig(rawConfig);
  if (!config.enabled) return { ok: true, skipped: true, allow: true, reason: '审核未开启' };
  if (!config.apiKey || !config.model) {
    return {
      ok: config.failOpen,
      allow: config.failOpen,
      skipped: false,
      reason: '审核已开启但缺少 review.apiKey/model'
    };
  }
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const { url, init } = buildReviewRequest(buffer, mime, config);
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(config.timeoutMs) });
  } catch (error) {
    return { ok: config.failOpen, allow: config.failOpen, reason: `审核服务不可用（${error?.message || '网络错误'}）` };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return { ok: config.failOpen, allow: config.failOpen, reason: `审核服务返回 HTTP ${res.status}` };
  }
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  const content = payload?.choices?.[0]?.message?.content;
  const verdict = extractJson(typeof content === 'string' ? content : JSON.stringify(content ?? ''));
  if (!verdict || typeof verdict.allow !== 'boolean') {
    // 模型没按格式回：默认拒绝，避免“看不懂就放行”。
    return { ok: config.failOpen, allow: config.failOpen, reason: '审核返回无法解析' };
  }
  const allow = verdict.allow === true;
  return {
    ok: allow,
    allow,
    skipped: false,
    reason: String(verdict.reason || (allow ? '通过' : '被审核拒绝')).slice(0, 120)
  };
}