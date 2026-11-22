#!/usr/bin/env node
// 表情去重与入库审核回归：dHash 计算/距离/近似判定、条目字段保留、审核 fail-closed。
// 用法：node scripts/test-sticker-dedup.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dhashFromGray, hammingHex, findNearDuplicate } from '../src/core/dhash.mjs';
import { computeDhash } from '../src/dhash-image.mjs';
import { normalizeReviewConfig, reviewImage } from '../src/core/image-review.mjs';
import { normalizeStickerEntry } from '../src/sticker-lib.js';
import { resolveFfmpeg } from '../src/voice-core.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';

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

await test('dHash：9x8 灰度 → 16 位十六进制', () => {
  const flat = new Uint8Array(72).fill(10);
  assert.equal(dhashFromGray(flat), '0000000000000000');
  const rising = new Uint8Array(72);
  for (let row = 0; row < 8; row += 1) for (let col = 0; col < 9; col += 1) rising[row * 9 + col] = col;
  assert.equal(dhashFromGray(rising), '0000000000000000', '左<右 → 0');
  const falling = new Uint8Array(72);
  for (let row = 0; row < 8; row += 1) for (let col = 0; col < 9; col += 1) falling[row * 9 + col] = 8 - col;
  assert.equal(dhashFromGray(falling), 'ffffffffffffffff', '左>右 → 1');
  assert.throws(() => dhashFromGray(new Uint8Array(10)), /72/);
});

await test('汉明距离：已知值与非法输入', () => {
  assert.equal(hammingHex('0000000000000000', '0000000000000001'), 1);
  assert.equal(hammingHex('ffffffffffffffff', '0000000000000000'), 64);
  assert.equal(hammingHex('bad', '0000000000000000'), 64);
});

await test('近似去重：阈值内命中、阈值外不命中、无指纹条目跳过', () => {
  const entries = [
    { id: 'old', dhash: '0000000000000000' },
    { id: 'nohash' }
  ];
  const hit = findNearDuplicate(entries, '0000000000000003', 6);
  assert.equal(hit?.entry.id, 'old');
  assert.equal(hit?.distance, 2);
  assert.equal(findNearDuplicate(entries, '0000000000000003', 1), null);
  assert.equal(findNearDuplicate(entries, 'not-a-hash', 6), null);
});

await test('表情条目保留 dHash；没有指纹时不写空字段', () => {
  const withHash = normalizeStickerEntry({ id: '1', dhash: 'ABCDEF0123456789' });
  assert.equal(withHash.dhash, 'abcdef0123456789');
  const without = normalizeStickerEntry({ id: '2' });
  assert.equal('dhash' in without, false);
});

await test('审核默认关闭时跳过', async () => {
  const res = await reviewImage(Buffer.from(PNG, 'base64'), 'image/png', {});
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
});

await test('审核开启但缺配置：fail-closed', async () => {
  const res = await reviewImage(Buffer.from(PNG, 'base64'), 'image/png', { enabled: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /apiKey/);
});

await test('审核通过 / 拒绝 / 返回无法解析', async () => {
  const cfg = normalizeReviewConfig({ enabled: true, apiKey: 'k', model: 'vlm' });
  const okFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '```json\n{"allow":true,"reason":"正常梗图"}\n```' } }] }) });
  const pass = await reviewImage(Buffer.from(PNG, 'base64'), 'image/png', cfg, { fetchImpl: okFetch });
  assert.equal(pass.ok, true);

  const denyFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"allow":false,"reason":"含二维码"}' } }] }) });
  const deny = await reviewImage(Buffer.from(PNG, 'base64'), 'image/png', cfg, { fetchImpl: denyFetch });
  assert.equal(deny.ok, false);
  assert.match(deny.reason, /二维码/);

  const badFetch = async () => ({ ok: true, status: 200, text: async () => 'not json' });
  const bad = await reviewImage(Buffer.from(PNG, 'base64'), 'image/png', cfg, { fetchImpl: badFetch });
  assert.equal(bad.ok, false, '无法解析必须 fail-closed');
});

await test('审核 failOpen=true 时服务异常放行', async () => {
  const cfg = normalizeReviewConfig({ enabled: true, apiKey: 'k', model: 'vlm', failOpen: true });
  const res = await reviewImage(Buffer.from(PNG, 'base64'), 'image/png', cfg, {
    fetchImpl: async () => { throw new Error('fetch failed'); }
  });
  assert.equal(res.ok, true);
});

await test('真实图片指纹（需要 ffmpeg；不可用则跳过）', async () => {
  // 优先用项目内的 tools/ffmpeg（生产代码同样读 config.socialV2.voice.ffmpegPath）。
  let cfgFfmpeg = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8'));
    cfgFfmpeg = String(cfg?.socialV2?.voice?.ffmpegPath || '').trim();
  } catch {}
  const ffmpeg = resolveFfmpeg({ ffmpegPath: process.env.FFMPEG_PATH || cfgFfmpeg || null });
  let usable = false;
  if (ffmpeg) {
    try {
      execFileSync(ffmpeg, ['-version'], { timeout: 10000, stdio: 'ignore' });
      usable = true;
    } catch {}
  }
  if (!usable) {
    console.log('SKIP 无可用的 ffmpeg，跳过真实图片指纹用例');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dhash-real-'));
  try {
    // 纯色图没有梯度，dHash 会全部为 0（无法区分）——用带纹理的测试源才有意义。
    const file = path.join(dir, 'src1.png');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=64x64', '-frames:v', '1', '-y', file], { timeout: 20000 });
    const buffer = fs.readFileSync(file);
    const a = computeDhash(buffer, { ffmpegPath: ffmpeg });
    const b = computeDhash(buffer, { ffmpegPath: ffmpeg });
    assert.match(a.hash, /^[0-9a-f]{16}$/);
    assert.equal(a.hash, b.hash, '同一张图的指纹必须稳定');
    const other = path.join(dir, 'src2.png');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64', '-frames:v', '1', '-y', other], { timeout: 20000 });
    const c = computeDhash(fs.readFileSync(other), { ffmpegPath: ffmpeg });
    assert.ok(hammingHex(a.hash, c.hash) > 6, '两种不同图案不应被当成重复');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(failed ? `\n${failed} 个用例失败` : '\n全部表情去重/审核用例通过');
process.exit(failed ? 1 : 0);