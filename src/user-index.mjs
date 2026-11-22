// 跨群用户索引：按 QQ 号串起这个人在所有会话里说过的话（供 scope=user 检索）。
//
// 为什么用单文件 JSONL 而不是每用户一个文件：
//   · 用户数可能上千，每用户一个文件会让 state 目录膨胀、清理困难；
//   · 检索只发生在主人/管理员手动查询时，扫 20 万行的成本可接受；
//   · 与消息归档同源同格式，便于排障。
import fs from 'node:fs';
import path from 'node:path';
// 截断必须按码点走：slice 会切在 emoji 代理对中间，留下孤立代理（落盘后显示成 �）。
import { truncateText } from './md-to-plain.js';

export const USER_INDEX_FILE = 'user-index.jsonl';
export const USER_INDEX_DEFAULT_MAX_LINES = 200000;

const lineCounts = new Map();

function fileFor(dir) {
  return path.join(dir, USER_INDEX_FILE);
}

function countLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * 追加一条用户索引。失败静默（索引只是增强，不能影响消息主链）。
 */
export function appendUserIndex(dir, key, entry, options = {}) {
  const file = fileFor(dir);
  const maxLines = Math.max(1000, Number(options.maxLines) || USER_INDEX_DEFAULT_MAX_LINES);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!lineCounts.has(file)) lineCounts.set(file, countLines(file));
    const row = {
      at: Number(entry?.at) || Date.now(),
      key: String(key || ''),
      userId: String(entry?.userId || ''),
      sender: truncateText(entry?.sender || '', 40),
      seq: entry?.seq ?? null,
      text: truncateText(entry?.text || '', 200)
    };
    if (!row.userId) return false;
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    const next = (lineCounts.get(file) || 0) + 1;
    lineCounts.set(file, next);
    if (next > maxLines) {
      try {
        fs.renameSync(file, `${file}.1`);
      } catch {
        fs.writeFileSync(file, '', 'utf8');
      }
      lineCounts.set(file, 0);
    }
    return true;
  } catch {
    return false;
  }
}

/** 读某个 QQ 号的索引（含轮转的 .1），按写入顺序返回。 */
export function readUserIndex(dir, userId) {
  const qq = String(userId || '').trim();
  if (!qq) return [];
  const file = fileFor(dir);
  const rows = [];
  for (const target of [`${file}.1`, file]) {
    let text = '';
    try { text = fs.readFileSync(target, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && String(obj.userId) === qq && Number.isFinite(Number(obj.at))) rows.push(obj);
      } catch {}
    }
  }
  return rows;
}

/** 测试/运维用：清掉内存行数缓存。 */
export function resetUserIndexCounts() {
  lineCounts.clear();
}