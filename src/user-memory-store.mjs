// 跨群用户记忆的存储层（JSON，原子写）。
//
// 为什么不用 SQLite：项目 engines 是 node>=22.13，node:sqlite 在 22.x 仍要实验 flag；
// 这里的数据量是「每个活跃 QQ 一条」，JSON 足够，也不改变启动方式。
import fs from 'node:fs';
import path from 'node:path';
import {
  emptyProfile,
  decayProfile,
  applyMessage,
  recordBoundaries
} from './core/user-memory.mjs';

export function loadUserMemory(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.users && typeof parsed.users === 'object' && !Array.isArray(parsed.users)) {
      return { version: 1, users: parsed.users };
    }
  } catch {}
  return { version: 1, users: {} };
}

export function saveUserMemory(file, store) {
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, users: store?.users || {} }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 超出上限时按 lastSeenAt 淘汰最久没出现的用户。 */
export function pruneUsers(store, maxUsers = 5000) {
  const entries = Object.entries(store?.users || {});
  if (entries.length <= maxUsers) return 0;
  entries.sort((a, b) => (Number(b[1]?.lastSeenAt) || 0) - (Number(a[1]?.lastSeenAt) || 0));
  const keep = entries.slice(0, maxUsers);
  store.users = Object.fromEntries(keep);
  return entries.length - keep.length;
}

/** 读一个用户并顺手做衰减（不写盘；调用方决定何时 save）。 */
export function getProfile(store, qq, now = Date.now()) {
  const key = String(qq ?? '').trim();
  if (!key || !store?.users) return null;
  const raw = store.users[key];
  if (!raw) return null;
  const decayed = decayProfile(raw, now);
  store.users[key] = decayed;
  return decayed;
}

/**
 * 记录一条入站消息：更新熟悉/信任/亲近/默契与边界。
 * @param {{users:object}} store
 * @param {{userId:string,nick?:string,key?:string,text:string,now?:number}} input
 * @param {{maxUsers?:number}} options
 */
export function recordIncomingMessage(store, input = {}, options = {}) {
  const qq = String(input.userId ?? '').trim();
  if (!qq || !store?.users) return null;
  const now = Number(input.now) || Date.now();
  const current = getProfile(store, qq, now) || emptyProfile(qq, now);
  let next = applyMessage(current, input, now);
  next = recordBoundaries(next, input.text, now);
  store.users[qq] = next;
  pruneUsers(store, Math.max(100, Number(options.maxUsers) || 5000));
  return next;
}