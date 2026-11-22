/**
 * 大图（>8MB）下载 + 归一化链路测试（2026-10-26 实测 bug 回归）。
 *
 * 现场 bug：
 *   [media] 表情获取失败（3 次尝试）: … 图片超过大小限制（8388608 字节）
 *   → 8MB 以上的 QQ 原图在下载阶段就被拒，模型一张都看不到。
 *
 * 修法（本测试的断言对象）：
 *   1. 下载上限与「送模型体积」解耦：`resolveMediaFetchLimit` 默认 16 MiB，
 *      并且**不会**被旧的 `maxBytes: 8388608` 压回去；
 *   2. >8MB 的原图能通过 `normalizeImageForModel` 压到 maxModelBytes（默认 1 MiB）以内，
 *      真正进得了模型。
 *
 * 依赖本机 ffmpeg（config.socialV2.voice.ffmpegPath / PATH）；缺失时跳过大图生成断言并明确提示。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  MEDIA_DEFAULTS,
  MEDIA_FETCH_LIMITS,
  normalizeImageForModel,
  resolveMediaFetchLimit,
  sniffImage,
} from '../src/media-normalize.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readConfig = () => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return {}; }
};
const cfg = readConfig();
const ffmpegPath = cfg?.socialV2?.voice?.ffmpegPath
  || process.env.FFMPEG_PATH
  || 'ffmpeg';

// ── 1) 下载上限默认 16 MiB，且旧配置 maxBytes(8MB) 不会把它压回去 ────────────
{
  const legacy = { maxBytes: 8 * 1024 * 1024, maxModelBytes: 1024 * 1024 };
  assert.equal(resolveMediaFetchLimit(legacy), MEDIA_FETCH_LIMITS.bytes, '旧 maxBytes=8MB 不应压低下载上限');
  assert.equal(resolveMediaFetchLimit(legacy), 16 * 1024 * 1024, '默认下载上限必须是 16 MiB');
  assert.equal(resolveMediaFetchLimit({ maxFetchBytes: 20 * 1024 * 1024 }), 20 * 1024 * 1024, '显式配置要生效');
  assert.equal(resolveMediaFetchLimit({ maxFetchBytes: 999 * 1024 * 1024 }), MEDIA_FETCH_LIMITS.maxBytes, '超上限要收敛到 32 MiB');
  assert.equal(resolveMediaFetchLimit({ maxFetchBytes: 1 }), MEDIA_FETCH_LIMITS.minBytes, '过小要收敛到 1 MiB');
  assert.equal(resolveMediaFetchLimit({ maxFetchBytes: 'abc' }), MEDIA_FETCH_LIMITS.bytes, '非法值回退默认');
  assert.equal(resolveMediaFetchLimit(), MEDIA_FETCH_LIMITS.bytes, '无配置时也要给默认 16 MiB');
  console.log('PASS 下载上限：默认 16 MiB，与 maxBytes(8MB) 解耦，可配且收敛');
}

// ── 2) 现场尺寸（约 8 MB）的大图：压到 ≤1 MiB，长边 ≤1280 ────────────────────
async function buildBigPng(side, outFile) {
  execFileSync(ffmpegPath, [
    '-v', 'error', '-y',
    '-f', 'lavfi',
    '-i', `nullsrc=s=${side}x${side},geq=random(1)*255:128:128,format=rgb24`,
    '-frames:v', '1',
    outFile,
  ], { timeoutMs: 120000 });
  return fs.readFileSync(outFile);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-bigimg-'));
try {
  // 2a) 2400×2400 噪声 PNG ≈ 8.0 MB（正是现场"8MB 被判超限"的量级）
  const siteLike = await buildBigPng(2400, path.join(tmpDir, 'site-like.png'));
  assert.ok(siteLike.length > 7.5 * 1024 * 1024, `现场量级原图应接近 8MB，实际 ${(siteLike.length / 1024 / 1024).toFixed(2)}MB`);
  const shrunk = await normalizeImageForModel(siteLike, 'image/png', {
    maxModelBytes: MEDIA_DEFAULTS.maxModelBytes,
    maxLongEdge: MEDIA_DEFAULTS.maxLongEdge,
    ffmpegPath,
    timeoutMs: 60000,
  });
  assert.equal(shrunk.ok, true, `8MB 级原图必须能压缩成功：${shrunk.error || ''}`);
  assert.ok(shrunk.buffer.length <= MEDIA_DEFAULTS.maxModelBytes,
    `压缩后必须 ≤${MEDIA_DEFAULTS.maxModelBytes} 字节，实际 ${shrunk.buffer.length}`);
  const info = sniffImage(shrunk.buffer);
  assert.ok(info && Math.max(info.width, info.height) <= MEDIA_DEFAULTS.maxLongEdge,
    `压缩后长边必须 ≤${MEDIA_DEFAULTS.maxLongEdge}，实际 ${info?.width}x${info?.height}`);
  console.log(`PASS 8MB 级原图：${(siteLike.length / 1024 / 1024).toFixed(2)}MB → ${(shrunk.buffer.length / 1024).toFixed(0)}KB（${info.width}×${info.height}）`);

  // 2b) 严格大于 8 MiB（旧下载上限）的图：证明"先下载再压缩"能救回来
  const over8 = await buildBigPng(2600, path.join(tmpDir, 'over-8mb.png'));
  assert.ok(over8.length > 8 * 1024 * 1024,
    `测试图必须 >8 MiB 才能覆盖旧 bug，实际 ${(over8.length / 1024 / 1024).toFixed(2)}MB`);
  // 旧行为：8MiB 下载上限直接拒绝（等价断言：字节数大于旧上限）
  assert.ok(over8.length > 8388608, '应超过旧下载上限 8388608 字节');
  // 新行为：下载上限 16MiB 放行 → 归一化压到模型可吃
  assert.ok(over8.length <= resolveMediaFetchLimit(cfg?.socialV2?.media), '16MiB 下载上限应放行该图');
  const shrunkBig = await normalizeImageForModel(over8, 'image/png', {
    maxModelBytes: MEDIA_DEFAULTS.maxModelBytes,
    maxLongEdge: MEDIA_DEFAULTS.maxLongEdge,
    ffmpegPath,
    timeoutMs: 60000,
  });
  assert.equal(shrunkBig.ok, true, `>8MiB 原图必须能压缩成功：${shrunkBig.error || ''}`);
  assert.ok(shrunkBig.buffer.length <= MEDIA_DEFAULTS.maxModelBytes,
    `>8MiB 压缩后必须 ≤${MEDIA_DEFAULTS.maxModelBytes} 字节，实际 ${shrunkBig.buffer.length}`);
  console.log(`PASS >8MiB 原图：${(over8.length / 1024 / 1024).toFixed(2)}MB（旧上限会拒）→ ${(shrunkBig.buffer.length / 1024).toFixed(0)}KB`);
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

console.log('PASS 大图链路：下载上限 16MiB + 归一化压缩 ≤1MiB');
