// 用 ffmpeg 把任意图片压成 9x8 灰度，再交给 dHash。
//
// 为什么走 ffmpeg：项目没有图像解码库；表情格式有 PNG/JPEG/GIF/WebP，纯 JS 解码
// 不现实。ffmpeg 缺失时抛错，由收藏流程降级为「不去重但仍可收藏」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dhashFromGray } from './core/dhash.mjs';

/**
 * @param {Buffer} buffer 图片原始字节
 * @param {{ffmpegPath?:string,tmpDir?:string,timeoutMs?:number}} options
 * @returns {{hash:string,width:number,height:number}}
 */
export function computeDhash(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('空图片，无法计算指纹');
  const ffmpeg = String(options.ffmpegPath || '').trim();
  if (!ffmpeg) throw new Error('找不到 ffmpeg（设置 FFMPEG_PATH 或 socialV2.voice.ffmpegPath）');

  const tmpDir = String(options.tmpDir || os.tmpdir());
  const tmp = path.join(tmpDir, `qq-dhash-${process.pid}-${crypto.randomBytes(4).toString('hex')}.img`);
  try {
    fs.writeFileSync(tmp, buffer);
    const gray = execFileSync(ffmpeg, [
      '-v', 'error',
      '-i', tmp,
      '-vf', 'scale=9:8:flags=area,format=gray',
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-'
    ], { timeout: Number(options.timeoutMs) || 15000, maxBuffer: 64 * 1024 });
    if (!gray || gray.length < 72) throw new Error(`ffmpeg 输出不足（${gray?.length || 0} 字节）`);
    return { hash: dhashFromGray(gray.subarray(0, 72)), width: 9, height: 8 };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}