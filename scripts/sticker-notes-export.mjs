#!/usr/bin/env node
// 表情备注对照表：把 state/stickers.json 里的本地备注/标签导成 Markdown 表格。
// 官方备注改不了（网关不支持 modify_custom_face），本地备注就是唯一能写的，导出成表方便人看。
// 用法：node scripts/sticker-notes-export.mjs [--all] [--out path.md] [--json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argVal = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const file = path.resolve(REPO_ROOT, argVal('--state-file', 'state/stickers.json'));
const outFile = argVal('--out', null);
const includeEmpty = process.argv.includes('--all');
const asJson = process.argv.includes('--json');

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const all = Array.isArray(raw) ? raw : Array.isArray(raw.stickers) ? raw.stickers : [];
const withNote = all.filter((s) => includeEmpty || String(s.localNote || '').trim() || (Array.isArray(s.tags) && s.tags.length));
withNote.sort((a, b) => Number(b.useCount || 0) - Number(a.useCount || 0));

const rows = withNote.map((s) => ({
  md5: String(s.md5 || (s.id || '').split('_').pop() || ''),
  note: String(s.localNote || '').replace(/\|/g, '\\|'),
  tags: Array.isArray(s.tags) ? s.tags.join(' / ') : '',
  desc: String(s.desc || '').replace(/\|/g, '\\|'),
  useCount: Number(s.useCount || 0),
}));

if (asJson) {
  console.log(JSON.stringify({ total: all.length, noted: withNote.length, rows }, null, 2));
} else {
  const lines = [
    `# 表情备注对照表（${withNote.length}/${all.length} 张有本地备注）`,
    '',
    '| md5 | 备注 | 标签 | 官方备注 | 用过 |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| \`${r.md5}\` | ${r.note} | ${r.tags} | ${r.desc} | ${r.useCount} |`),
  ];
  const text = `${lines.join('\n')}\n`;
  if (outFile) {
    fs.writeFileSync(path.resolve(REPO_ROOT, outFile), text, 'utf8');
    console.log(`已写 ${withNote.length} 张到 ${outFile}`);
  } else {
    process.stdout.write(text);
  }
}
