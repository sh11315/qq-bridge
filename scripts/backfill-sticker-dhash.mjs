#!/usr/bin/env node
// 给存量表情补 dHash（默认 dry-run，--write 才落盘）。
// 用法：
//   node scripts/backfill-sticker-dhash.mjs                 // 试跑 20 条
//   node scripts/backfill-sticker-dhash.mjs --limit=50      // 试跑 50 条
//   node scripts/backfill-sticker-dhash.mjs --limit=50 --write
import fs from 'node:fs';
import { loadStickerStore, saveStickerStore } from '../src/sticker-lib.js';
import { computeDhash } from '../src/dhash-image.mjs';
import { resolveFfmpeg } from '../src/voice-core.js';
import { safeFetchBuffer } from '../src/safe-fetch.js';

const FILE = 'state/stickers.json';
const args = process.argv.slice(2);
const write = args.includes('--write');
const limit = Math.min(200, Math.max(1, Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 20));

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const ffmpeg = resolveFfmpeg({ ffmpegPath: cfg.socialV2?.voice?.ffmpegPath || null });
let entries;
try {
  entries = loadStickerStore(FILE);
} catch (error) {
  console.error(String(error?.message || error));
  process.exit(1);
}

const todo = entries.filter((e) => e && !e.dhash && /^https?:\/\//i.test(String(e.url || ''))).slice(0, limit);
let ok = 0;
let failed = 0;
for (const entry of todo) {
  try {
    const fetched = await safeFetchBuffer(entry.url, 8 * 1024 * 1024);
    const { hash } = computeDhash(fetched.buffer, { ffmpegPath: ffmpeg });
    entry.dhash = hash;
    ok += 1;
  } catch (error) {
    failed += 1;
    console.log(`SKIP ${entry.id}: ${String(error?.message || error).slice(0, 100)}`);
  }
}
console.log(JSON.stringify({ file: FILE, total: entries.length, candidates: todo.length, ok, failed, write }));
if (write && ok > 0) {
  saveStickerStore(FILE, entries);
  console.log('saved');
}