#!/usr/bin/env node
// 从历史归档回填跨群用户索引（默认 dry-run，--write 才落盘）。
// 用法：
//   node scripts/backfill-user-index.mjs
//   node scripts/backfill-user-index.mjs --write
import fs from 'node:fs';
import path from 'node:path';
import { appendUserIndex, resetUserIndexCounts } from '../src/user-index.mjs';

const ARCHIVE_DIR = 'state/message-archive';
const STATE_DIR = 'state';
const args = process.argv.slice(2);
const write = args.includes('--write');
const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const maxLines = Number(cfg.socialV2?.history?.userIndexMaxLines) || undefined;

if (!fs.existsSync(ARCHIVE_DIR)) {
  console.log(`没有归档目录（${ARCHIVE_DIR}），无需回填`);
  process.exit(0);
}

const rows = [];
const seen = new Set();
let files = 0;
for (const name of fs.readdirSync(ARCHIVE_DIR).filter((f) => /\.jsonl(\.1)?$/.test(f))) {
  files += 1;
  const key = name.replace(/\.jsonl(\.1)?$/, '').replace('_', ':');
  let text = '';
  try { text = fs.readFileSync(path.join(ARCHIVE_DIR, name), 'utf8'); } catch { continue; }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row = null;
    try { row = JSON.parse(trimmed); } catch { continue; }
    if (!row || row.isSelf || !row.userId) continue;
    const msgText = String(row.text || '').trim();
    if (!msgText) continue;
    const at = Number(row.at) || 0;
    const seqKey = row.seq != null ? `${key}:${row.seq}` : `${key}:${at}:${msgText.slice(0, 40)}`;
    if (seen.has(seqKey)) continue;
    seen.add(seqKey);
    rows.push({
      at,
      key,
      userId: String(row.userId),
      sender: String(row.sender || ''),
      seq: row.seq ?? null,
      text: msgText.slice(0, 200)
    });
  }
}
rows.sort((a, b) => a.at - b.at);
const users = new Set(rows.map((row) => row.userId));
const sample = rows.slice(0, 5).map((row) => ({ at: row.at, key: row.key, hasText: !!row.text }));

console.log(JSON.stringify({ files, rows: rows.length, users: users.size, write, sample }));
if (write && rows.length > 0) {
  resetUserIndexCounts();
  let written = 0;
  for (const row of rows) {
    if (appendUserIndex(STATE_DIR, row.key, row, { maxLines })) written += 1;
  }
  console.log(JSON.stringify({ written, file: path.join(STATE_DIR, 'user-index.jsonl') }));
}