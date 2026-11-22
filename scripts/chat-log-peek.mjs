#!/usr/bin/env node
// 聊天记录速查：醒来先看「刚才谁说了话、我回过没、有没有报错」。
// 用法：
//   node scripts/chat-log-peek.mjs                        # 私聊 owner 最近 60 分钟
//   node scripts/chat-log-peek.mjs --minutes 180 --limit 80
//   node scripts/chat-log-peek.mjs --key group:100000003
//   node scripts/chat-log-peek.mjs --grep 报错 --logs 400  # 顺带翻 bridge.log
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const STATE = path.join(ROOT, 'state');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const key = String(arg('key', 'private:100000001'));
const minutes = Number(arg('minutes', 60));
const limit = Number(arg('limit', 50));
const grep = arg('grep', '');
const logLines = Number(arg('logs', 200));

function fmt(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime()) || !Number(ts)) return '??:??';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

let social = {};
try { social = JSON.parse(fs.readFileSync(path.join(STATE, 'social-v2.json'), 'utf8')); } catch (err) {
  console.error(`读不到 state/social-v2.json：${err.message}`);
  process.exit(1);
}

const convs = social.conversations || {};
const st = convs[key];
if (!st) {
  console.log(`没有这个会话：${key}`);
  console.log(`现有会话：${Object.keys(convs).join(', ') || '（空）'}`);
  process.exit(0);
}

const since = Date.now() - minutes * 60_000;
const all = Array.isArray(st.recentMessages) ? st.recentMessages : [];
const picked = all.filter((m) => Number(m?.time || 0) >= since);
const shown = (picked.length ? picked : all).slice(-limit);
const where = picked.length ? `最近 ${minutes} 分钟` : `最近 ${limit} 条（${minutes} 分钟内没消息）`;

function textOf(m) {
  if (!m || typeof m !== 'object') return '';
  const raw = m.text ?? m.plain ?? m.raw ?? m.content ?? '';
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (Array.isArray(m.media) && m.media.length) return `[${m.media.map((x) => x?.kind || '媒体').join('+')}]`;
  if (m.hasMedia) return '[媒体]';
  if (m.hasForward || (Array.isArray(m.forwardIds) && m.forwardIds.length)) return '[转发]';
  return '';
}

console.log(`== ${key} · ${where} · 共 ${all.length} 条缓存 ==`);
if (!all.length) console.log('（这个会话没有 recentMessages 缓存，可能还没收过消息）');
for (const m of shown) {
  const who = m?.isSelf ? '我' : (m?.sender || m?.userId || '对方');
  const text = String(textOf(m)).replace(/\s+/g, ' ').slice(0, 140) || '（空）';
  if (grep && !text.includes(String(grep))) continue;
  console.log(`${fmt(m?.time)}  ${who}: ${text}`);
}

const selfRecent = picked.filter((m) => m.isSelf).length;
console.log(`-- 我发言 ${selfRecent} 条 / 对方 ${picked.length - selfRecent} 条`);

if (grep) {
  console.log(`\n== bridge.log 里含「${grep}」的行（最后 ${logLines} 行内）==`);
  let lines = [];
  try { lines = fs.readFileSync(path.join(STATE, 'bridge.log'), 'utf8').split('\n'); } catch { /* 忽略 */ }
  const hit = lines.slice(-logLines).filter((l) => l.includes(String(grep)));
  console.log(hit.length ? hit.slice(-30).join('\n') : '（没命中）');
}

const wake = st.wakeConfig || {};
console.log(`\n== 唤醒 == mode=${wake.mode} infinite=${wake.infinite} sleepUntil=${wake.sleepUntil || '-'}`);
console.log(`triggers=${JSON.stringify(wake.triggers || {})}`);
console.log(`unread=${st.unreadCount ?? '-'} readThroughSeq=${st.readThroughSeq ?? '-'}`);
