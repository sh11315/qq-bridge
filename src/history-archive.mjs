// 会话消息归档：给「回忆检索」提供比 recentMessages(100 条) 更长的历史。
//
// 为什么不用 SQLite：项目 engines 是 node>=22.13，而 node:sqlite 在 22.x 仍需
// --experimental-sqlite；为了不改变启动方式，这里用「按会话分文件的 JSONL」：
//   state/message-archive/group_100000004.jsonl
// 每个文件到上限后 rename 成 .1（旧文件），检索时两份都读。
import fs from 'node:fs';
import path from 'node:path';

export const ARCHIVE_DIR_NAME = 'message-archive';
export const DEFAULT_MAX_LINES = 50000;

/** 会话 key → 安全文件名（只允许字母/数字/下划线/短横线）。 */
export function archiveFileName(key) {
  const raw = String(key ?? '').trim();
  if (!/^(group|private):[A-Za-z0-9_-]{1,64}$/.test(raw)) return '';
  return raw.replace(':', '_');
}

export function archivePath(dir, key) {
  const name = archiveFileName(key);
  return name ? path.join(dir, `${name}.jsonl`) : '';
}

const lineCounts = new Map(); // file -> 已写行数（-1 表示还没数过）

function countLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * 追加一条归档。失败静默：归档只是增强能力，绝不能影响消息主链。
 * @param {string} dir      归档目录（通常是 <state>/message-archive）
 * @param {string} key      会话 key
 * @param {object} entry    { at,key,seq,messageId,sender,userId,text,isSelf }
 */
export function appendArchive(dir, key, entry, options = {}) {
  const file = archivePath(dir, key);
  if (!file) return false;
  const maxLines = Math.max(100, Number(options.maxLines) || DEFAULT_MAX_LINES);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!lineCounts.has(file)) lineCounts.set(file, countLines(file));
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    const next = (lineCounts.get(file) || 0) + 1;
    lineCounts.set(file, next);
    if (next > maxLines) {
      try {
        fs.renameSync(file, `${file}.1`);
      } catch {
        // 改名失败就截断，保证不会无限增长
        fs.writeFileSync(file, '', 'utf8');
      }
      lineCounts.set(file, 0);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取某会话的归档（含轮转出的 .1），按写入顺序返回。
 * 只信任 key 匹配的行，避免文件被手工拼接后串会话。
 */
export function readArchive(dir, key) {
  const file = archivePath(dir, key);
  if (!file) return [];
  const rows = [];
  for (const target of [`${file}.1`, file]) {
    let text = '';
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && obj.key === key && Number.isFinite(Number(obj.at))) rows.push(obj);
      } catch {}
    }
  }
  return rows;
}

/** 测试/运维用：清掉内存里的行数缓存（例如手工删了归档文件后）。 */
export function resetArchiveCounts() {
  lineCounts.clear();
}