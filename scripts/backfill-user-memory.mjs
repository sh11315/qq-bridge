#!/usr/bin/env node
// 从消息归档回填跨群用户关系（默认 dry-run，--write 才落盘）。
//
// 只统计数值与短句，不保留聊天原文；与现有关系取较大值合并，不会把已有关系改小。
// 用法：
//   node scripts/backfill-user-memory.mjs
//   node scripts/backfill-user-memory.mjs --write
import fs from 'node:fs';
import path from 'node:path';
import {
  emptyProfile,
  messageSeed,
  recordBoundaries,
  relationshipWords,
  USER_MEMORY_DEFAULTS
} from '../src/core/user-memory.mjs';
import { loadUserMemory, saveUserMemory } from '../src/user-memory-store.mjs';

const ARCHIVE_DIR = 'state/message-archive';
const STORE_FILE = 'state/user-memory.json';
const args = process.argv.slice(2);
const write = args.includes('--write');
const limit = Math.min(5000, Math.max(1, Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 500));
const POS = /谢谢|喜欢你|厉害|真好|辛苦|可爱|靠谱|信任你/;
const NEG = /滚|闭嘴|烦死|讨厌你|别烦|傻[逼比]|无语/;
const PLACEHOLDER = /^(私聊|群聊|未知|群友)$/;
const clamp = (v) => Math.min(100, Math.max(0, v));

function keyFromFile(name) {
  const base = name.replace(/\.jsonl$/i, '');
  return base.replace('_', ':');
}

const byUser = new Map();
if (!fs.existsSync(ARCHIVE_DIR)) {
  console.log(`没有归档目录（${ARCHIVE_DIR}），无需回填`);
  process.exit(0);
}
for (const file of fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.jsonl'))) {
  const key = keyFromFile(file);
  let text = '';
  try { text = fs.readFileSync(path.join(ARCHIVE_DIR, file), 'utf8'); } catch { continue; }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row = null;
    try { row = JSON.parse(trimmed); } catch { continue; }
    if (!row || row.isSelf || !row.userId) continue;
    const qq = String(row.userId);
    const item = byUser.get(qq) || { qq, nick: '', count: 0, firstAt: Infinity, lastAt: 0, groups: new Set(), texts: [] };
    item.count += 1;
    item.firstAt = Math.min(item.firstAt, Number(row.at) || Date.now());
    item.lastAt = Math.max(item.lastAt, Number(row.at) || 0);
    if (key.startsWith('group:')) item.groups.add(key.slice(6));
    const sender = String(row.sender || '').trim();
    if (sender && !PLACEHOLDER.test(sender)) item.nick = sender;
    item.texts.push(String(row.text || '').slice(0, 200));
    byUser.set(qq, item);
  }
}

const store = loadUserMemory(STORE_FILE);
const now = Date.now();
const profiles = [];
for (const item of byUser.values()) {
  let profile = emptyProfile(item.qq, now);
  profile.nick = item.nick;
  profile.messageCount = item.count;
  profile.interactions = item.count;
  profile.familiarity = messageSeed(item.count, USER_MEMORY_DEFAULTS.familiarityCap);
  profile.rapport = messageSeed(item.count, USER_MEMORY_DEFAULTS.rapportCap);
  profile.trust = clamp(48 + Math.min(6, item.count * 0.02));
  let closeness = 20;
  for (const text of item.texts) {
    if (POS.test(text)) closeness += 1.2;
    else if (NEG.test(text)) closeness -= 1.8;
  }
  profile.closeness = clamp(closeness);
  profile.groups = [...item.groups].slice(-20);
  profile.lastSeenAt = item.lastAt;
  for (const text of item.texts) profile = recordBoundaries(profile, text, now);
  profiles.push(profile);
}

profiles.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
const picked = profiles.slice(0, limit);
let merged = 0;
for (const p of picked) {
  const current = store.users[p.qq];
  if (!current) {
    store.users[p.qq] = p;
    merged += 1;
    continue;
  }
  const boundaries = new Map();
  for (const b of [...(current.boundaries || []), ...(p.boundaries || [])]) {
    if (!b || !b.kind || !b.text) continue;
    const k = `${b.kind}:${b.text}`;
    const old = boundaries.get(k);
    if (!old || (Number(b.hits) || 0) > (Number(old.hits) || 0)) boundaries.set(k, b);
  }
  store.users[p.qq] = {
    ...current,
    nick: current.nick && !PLACEHOLDER.test(current.nick) ? current.nick : p.nick,
    messageCount: Math.max(Number(current.messageCount) || 0, p.messageCount),
    interactions: Math.max(Number(current.interactions) || 0, p.interactions),
    familiarity: Math.max(Number(current.familiarity) || 0, p.familiarity),
    rapport: Math.max(Number(current.rapport) || 0, p.rapport),
    closeness: Math.max(Number(current.closeness) || 0, p.closeness),
    trust: Math.max(Number(current.trust) || 48, p.trust),
    groups: [...new Set([...(current.groups || []), ...(p.groups || [])])].slice(-20),
    boundaries: [...boundaries.values()].slice(-USER_MEMORY_DEFAULTS.maxBoundaries),
    lastSeenAt: Math.max(Number(current.lastSeenAt) || 0, p.lastSeenAt),
    updatedAt: now
  };
  merged += 1;
}

for (const p of picked.slice(0, 10)) {
  const words = relationshipWords(p);
  console.log(`${p.qq} 消息=${p.messageCount} 熟悉=${words.familiarity} 信任=${words.trust} 亲近=${words.closeness} 默契=${words.rapport}`);
}
console.log(JSON.stringify({ users: profiles.length, picked: picked.length, merged, write }));
if (write && merged > 0) {
  if (saveUserMemory(STORE_FILE, store)) console.log('saved');
  else { console.error('保存失败'); process.exit(1); }
}