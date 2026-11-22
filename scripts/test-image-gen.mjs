#!/usr/bin/env node
// 图片生成适配层回归：配置归一、请求构造（含图生图）、响应解析、错误可读、工具面。
// 用法：node scripts/test-image-gen.mjs
import assert from 'node:assert';
import {
  normalizeImageGenConfig,
  imageGenReady,
  buildImageRequest,
  generateImage
} from '../src/image-gen.mjs';
import { featureAllowsFlag, FEATURE_TOOL_FLAGS } from '../src/core/feature-sessions.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';
const base = { enabled: true, provider: 'openai', apiKey: 'sk-test', model: 'img-test', baseUrl: 'https://api.example/v1' };

let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
};

await test('配置归一：默认值、未知 provider 回退、数值夹取', () => {
  const cfg = normalizeImageGenConfig({ provider: 'nope', timeoutMs: 1, maxPerDay: 9999 });
  assert.equal(cfg.provider, 'openai');
  assert.ok(cfg.timeoutMs >= 10000);
  assert.equal(cfg.maxPerDay, 500);
  assert.equal(normalizeImageGenConfig({}).enabled, false);
});

await test('可用性：未启用/缺 key/缺 model/ComfyUI 都给出可读原因', () => {
  assert.equal(imageGenReady(normalizeImageGenConfig({})).ok, false);
  assert.match(imageGenReady(normalizeImageGenConfig({ enabled: true, model: 'x' })).reason, /apiKey/);
  assert.match(imageGenReady(normalizeImageGenConfig({ enabled: true, apiKey: 'k' })).reason, /model/);
  assert.match(imageGenReady(normalizeImageGenConfig({ ...base, provider: 'comfyui' })).reason, /ComfyUI/);
  assert.equal(imageGenReady(normalizeImageGenConfig(base)).ok, true);
});

await test('openai 无参考图 → /images/generations + b64_json', () => {
  const cfg = normalizeImageGenConfig(base);
  const { url, init } = buildImageRequest(cfg, { prompt: '一只猫' });
  assert.equal(url, 'https://api.example/v1/images/generations');
  assert.equal(init.method, 'POST');
  const body = JSON.parse(init.body);
  assert.equal(body.response_format, 'b64_json');
  assert.equal(body.model, 'img-test');
});

await test('openai 有参考图 → multipart /images/edits（图生图）', () => {
  const cfg = normalizeImageGenConfig(base);
  const { url, init } = buildImageRequest(cfg, {
    prompt: '改成夜景',
    references: [{ buffer: Buffer.from(PNG, 'base64'), mime: 'image/png' }]
  });
  assert.equal(url, 'https://api.example/v1/images/edits');
  assert.ok(init.body instanceof FormData, '必须是 multipart FormData');
});

await test('seedream 参考图走 image 数组；gemini 走 inline_data', () => {
  const seed = normalizeImageGenConfig({ ...base, provider: 'seedream' });
  const seedReq = buildImageRequest(seed, {
    prompt: '同款',
    references: [{ buffer: Buffer.from(PNG, 'base64'), mime: 'image/png' }]
  });
  const seedBody = JSON.parse(seedReq.init.body);
  assert.ok(Array.isArray(seedBody.image) && seedBody.image[0].startsWith('data:image/png;base64,'));

  const gem = normalizeImageGenConfig({ ...base, provider: 'gemini', model: 'gemini-img' });
  const gemReq = buildImageRequest(gem, { prompt: '一只猫' });
  assert.match(gemReq.url, /:generateContent\?key=/);
  const gemBody = JSON.parse(gemReq.init.body);
  assert.deepEqual(gemBody.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
});

await test('生成成功：b64 → Buffer + mime', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ b64_json: PNG, revised_prompt: 'a cat' }] })
  });
  const out = await generateImage({ prompt: '一只猫' }, base, { fetchImpl });
  assert.ok(Buffer.isBuffer(out.buffer));
  assert.equal(out.mime, 'image/png');
  assert.equal(out.provider, 'openai');
  assert.equal(out.revisedPrompt, 'a cat');
});

await test('生成失败：HTTP 错误带服务端原因', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: { message: 'model not found' } })
  });
  await assert.rejects(() => generateImage({ prompt: 'x' }, base, { fetchImpl }), /HTTP 400 model not found/);
});

await test('生成失败：返回非图片内容会被拒绝', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ b64_json: Buffer.from('not-an-image').toString('base64') }] })
  });
  await assert.rejects(() => generateImage({ prompt: 'x' }, base, { fetchImpl }), /不是有效图片/);
});

await test('生成失败：网络拒绝给出可读提示', async () => {
  const fetchImpl = async () => {
    const err = new Error('fetch failed');
    err.cause = { code: 'ECONNREFUSED' };
    throw err;
  };
  await assert.rejects(() => generateImage({ prompt: 'x' }, base, { fetchImpl }), /连接被拒绝/);
});

await test('工具面：仅 web 域允许 generateImage', () => {
  assert.equal(featureAllowsFlag('web', 'generateImage'), true);
  for (const feature of ['chat', 'vision', 'voice', 'sticker']) {
    assert.equal(featureAllowsFlag(feature, 'generateImage'), false, `${feature} 不应允许出图`);
  }
  assert.ok(FEATURE_TOOL_FLAGS.web.includes('generateImage'));
});

console.log(failed ? `\n${failed} 个用例失败` : '\n全部图片生成用例通过');
process.exit(failed ? 1 : 0);