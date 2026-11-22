// 图片生成适配层（不引入新依赖）。
//
// 支持：
//   · openai  —— OpenAI / xAI / 各类兼容中转的 /images/generations；
//                有参考图时走 /images/edits（multipart），即图生图；
//   · seedream —— 火山方舟 Seedream（OpenAI 风格 + image 数组做参考图）；
//   · gemini  —— Google Gemini generateContent，返回 inlineData；
//   · comfyui —— 未实现（workflow 因部署而异），配置后给出明确提示。
//
// 本模块只负责「拿到一张图」，发送与落盘由 bridge 负责。

import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';

export const IMAGE_PROVIDERS = Object.freeze(['openai', 'seedream', 'gemini', 'comfyui']);
export const DEFAULT_IMAGE_GEN = Object.freeze({
  enabled: false,
  provider: 'openai',
  baseUrl: '',
  apiKey: '',
  model: '',
  size: '1024x1024',
  timeoutMs: 180000,
  maxBytes: 12 * 1024 * 1024,
  maxPerDay: 20,
  minIntervalMs: 5000
});

const PROVIDER_DEFAULT_BASE = Object.freeze({
  openai: 'https://api.openai.com/v1',
  seedream: 'https://ark.cn-beijing.volces.com/api/v3',
  gemini: 'https://generativelanguage.googleapis.com'
});

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function normalizeImageGenConfig(raw = {}) {
  const merged = { ...DEFAULT_IMAGE_GEN, ...(raw && typeof raw === 'object' ? raw : {}) };
  const provider = String(merged.provider || 'openai').toLowerCase();
  return {
    ...merged,
    provider: IMAGE_PROVIDERS.includes(provider) ? provider : 'openai',
    baseUrl: String(merged.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(merged.apiKey || '').trim(),
    model: String(merged.model || '').trim(),
    size: String(merged.size || DEFAULT_IMAGE_GEN.size).trim(),
    timeoutMs: clampInt(merged.timeoutMs, 10000, 600000, DEFAULT_IMAGE_GEN.timeoutMs),
    maxBytes: clampInt(merged.maxBytes, 1024 * 1024, 40 * 1024 * 1024, DEFAULT_IMAGE_GEN.maxBytes),
    maxPerDay: clampInt(merged.maxPerDay, 1, 500, DEFAULT_IMAGE_GEN.maxPerDay),
    minIntervalMs: clampInt(merged.minIntervalMs, 0, 300000, DEFAULT_IMAGE_GEN.minIntervalMs)
  };
}

/** 配置是否可用；不可用时返回可读原因（不抛错，便于工具直接回给模型）。 */
export function imageGenReady(config) {
  if (!config?.enabled) return { ok: false, reason: '图片生成未启用（config.imageGen.enabled=false）' };
  if (config.provider === 'comfyui') return { ok: false, reason: 'ComfyUI 适配尚未接入：请先配置 openai 兼容端点（imageGen.provider=openai）' };
  if (!config.model) return { ok: false, reason: '缺少 imageGen.model（图片模型名）' };
  if (!config.apiKey) return { ok: false, reason: '缺少 imageGen.apiKey' };
  return { ok: true };
}

function sniffMime(buffer) {
  if (!buffer || buffer.length < 12) return 'image/png';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/png';
}

function toDataUrl(mime, buffer) {
  return `data:${mime || 'image/png'};base64,${buffer.toString('base64')}`;
}

function errorSummary(payload, text) {
  const fromJson = payload?.error?.message || payload?.message || payload?.error?.code || payload?.error;
  if (typeof fromJson === 'string' && fromJson.trim()) return fromJson.trim().slice(0, 300);
  if (typeof fromJson === 'object' && fromJson) {
    try { return JSON.stringify(fromJson).slice(0, 300); } catch {}
  }
  return String(text || '').trim().slice(0, 300);
}

/**
 * 构造请求（导出便于单测/排查，不联网）。
 * @returns {{url:string, init:object}}
 */
export function buildImageRequest(config, input = {}) {
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) throw new Error('prompt 不能为空');
  const size = String(input.size || config.size || DEFAULT_IMAGE_GEN.size);
  const references = Array.isArray(input.references) ? input.references.filter((r) => r && Buffer.isBuffer(r.buffer)) : [];
  const base = config.baseUrl || PROVIDER_DEFAULT_BASE[config.provider] || PROVIDER_DEFAULT_BASE.openai;

  if (config.provider === 'gemini') {
    const parts = [{ text: prompt }];
    for (const ref of references) {
      parts.push({ inline_data: { mime_type: ref.mime || 'image/png', data: ref.buffer.toString('base64') } });
    }
    return {
      url: `${base}/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
        })
      }
    };
  }

  if (config.provider === 'openai' && references.length > 0) {
    // 图生图：/images/edits 必须 multipart，Node 18+ 内置 FormData/Blob。
    const form = new FormData();
    form.append('model', config.model);
    form.append('prompt', prompt);
    form.append('size', size);
    form.append('n', '1');
    references.forEach((ref, index) => {
      form.append('image', new Blob([ref.buffer], { type: ref.mime || 'image/png' }), ref.name || `ref-${index}.png`);
    });
    return {
      url: `${base}/images/edits`,
      init: { method: 'POST', headers: { authorization: `Bearer ${config.apiKey}` }, body: form }
    };
  }

  // openai（无参考）/ seedream（参考图放进 image 数组）
  const body = { model: config.model, prompt, n: 1, size };
  if (config.provider === 'seedream') {
    if (references.length) body.image = references.map((ref) => toDataUrl(ref.mime, ref.buffer));
  } else {
    body.response_format = 'b64_json';
  }
  return {
    url: `${base}/images/generations`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body)
    }
  };
}

function extractCandidates(provider, payload) {
  const out = [];
  const push = (item) => {
    if (!item || typeof item !== 'object') return;
    const b64 = item.b64_json || item.b64Json || item.image_base64 || item.base64;
    const url = item.url || item.image_url;
    if (b64) out.push({ b64, revisedPrompt: item.revised_prompt || item.revisedPrompt || '' });
    else if (url) out.push({ url, revisedPrompt: item.revised_prompt || item.revisedPrompt || '' });
  };
  if (provider === 'gemini') {
    for (const candidate of payload?.candidates || []) {
      for (const part of candidate?.content?.parts || []) {
        const inline = part?.inlineData || part?.inline_data;
        if (inline?.data) out.push({ b64: inline.data, revisedPrompt: part?.text || '' });
      }
    }
    return out;
  }
  for (const item of payload?.data || payload?.images || []) push(item);
  return out;
}

/**
 * 生成一张图。
 * @param {{prompt:string,size?:string,references?:Array<{buffer:Buffer,mime?:string,name?:string}>}} input
 * @param {object} rawConfig config.imageGen
 * @param {{fetchImpl?:Function}} [deps] 测试注入
 * @returns {Promise<{buffer:Buffer,mime:string,provider:string,model:string,revisedPrompt:string}>}
 */
export async function generateImage(input, rawConfig, deps = {}) {
  const config = normalizeImageGenConfig(rawConfig);
  const ready = imageGenReady(config);
  if (!ready.ok) throw new Error(ready.reason);
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const { url, init } = buildImageRequest(config, input);

  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(config.timeoutMs) });
  } catch (error) {
    const code = String(error?.cause?.code || error?.code || '');
    const detail = code === 'ECONNREFUSED' ? '连接被拒绝'
      : /timeout/i.test(String(error?.message || '')) ? '请求超时'
        : /fetch failed/i.test(String(error?.message || '')) ? '网络请求失败'
          : String(error?.message || '网络错误');
    throw new Error(`图片服务不可达（${detail}）：${url.replace(/\?.*$/, '')}`);
  }

  const text = await res.text().catch(() => '');
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  if (!res.ok) {
    throw new Error(`图片生成失败：HTTP ${res.status} ${errorSummary(payload, text)}`.trim());
  }

  const candidates = extractCandidates(config.provider, payload);
  if (!candidates.length) throw new Error('图片生成返回里没有图片（检查 imageGen.model 是否支持该接口）');

  const first = candidates[0];
  let buffer = null;
  if (first.b64) buffer = Buffer.from(String(first.b64), 'base64');
  else {
    const fetched = await safeFetchBuffer(first.url, config.maxBytes);
    buffer = fetched.buffer;
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('图片生成返回了空内容');
  if (buffer.length > config.maxBytes) throw new Error(`生成图片过大（${buffer.length} 字节，上限 ${config.maxBytes}）`);
  if (!looksLikeImageBuffer(buffer)) throw new Error('生成结果不是有效图片（PNG/JPEG/GIF/WebP）');

  return {
    buffer,
    mime: sniffMime(buffer),
    provider: config.provider,
    model: config.model,
    revisedPrompt: String(first.revisedPrompt || '').slice(0, 500)
  };
}