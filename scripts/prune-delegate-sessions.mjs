#!/usr/bin/env node
/**
 * 清理「子智能体会话」堆 —— 安全版（2026-11-02 误删主会话事故后加固）。
 *
 * 事故回顾：2026-11-02 15:50，一条 `Get-ChildItem ~/.dsh/sessions/<默认工作区> |
 * Where-Object mtime < 1h | Move-Item` 把该工作区 44 个会话目录整体归档，
 * 其中 7 个是 delegationDepth=0 的主会话（含 session-5371e1e8，24.9MB），
 * 文件移走后 GUI 打开这些会话直接报
 *   ENOENT: no such file or directory ... session.v4.jsonl.zstd。
 * 事后已从 state/backups/subagents-20261102 全部恢复。
 *
 * 本脚本的硬性保护（比“按 mtime 全量挪”安全得多）：
 *   1. 只允许移动日志 header 里 delegationDepth > 0 的子智能体会话；
 *      主会话（depth 0，含 GUI 里能看到的所有正常会话）一律不动。
 *   2. 日志 header 解析失败 / 文件缺失 → 视为不确定，跳过不碰。
 *   3. 跳过 workspace.json、state/sessions.json、state/turn-sender.json
 *      里出现过的 session id（哪怕它是子会话，正在用就不挪）。
 *   4. 跳过当前进程所在工作区的 slug（别把自己清掉）。
 *   5. 只挪不删，备份到 state/backups/delegate-sessions-YYYYMMDD/。
 *
 * 规则：每个工作区按 mtime 保留最近 KEEP 个（默认 6），其余且 mtime 早于
 * MIN_AGE_HOURS（默认 1h）的子智能体会话才挪走。
 *
 * 用法：
 *   node scripts/prune-delegate-sessions.mjs --dry     # 预览，不落地
 *   node scripts/prune-delegate-sessions.mjs           # 真跑
 *   node scripts/prune-delegate-sessions.mjs --keep 8 --min-age-h 2
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const WORKSPACE_STORE = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');

function argNum(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const DRY = process.argv.includes('--dry');
const KEEP = argNum('--keep', 6);
const MIN_AGE_HOURS = argNum('--min-age-h', 1);
const UUID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 由 cwd 推导 DSH 的 workspace slug（用于跳过当前工作区）。 */
function slugFor(cwd) {
  return '--' + cwd.replace(/:/g, '').replace(/[\\/]/g, '-') + '--';
}

const CURRENT_SLUG = slugFor(process.cwd());

// ---------------------------------------------------------------------------
// zstd 首帧读取（DSH 会话日志 = 多帧 zstd 拼接，首帧只含 session header 行）
// ---------------------------------------------------------------------------
const ZSTD_MAGIC = 0xfd2fb528;

function readZstdFrameEnd(buffer, start) {
  let offset = start;
  if (offset + 4 > buffer.length || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
    throw new Error(`非法 zstd 帧 @${start}`);
  }
  offset += 4;
  if (offset >= buffer.length) throw new Error('zstd 帧头截断');
  const frameHeader = buffer[offset];
  offset += 1;
  const fcsFlag = frameHeader >> 6;
  const singleSegment = (frameHeader >> 5) & 1;
  const hasChecksum = (frameHeader >> 2) & 1;
  const dictFlag = frameHeader & 3;
  if (!singleSegment) offset += 1;
  offset += [0, 1, 2, 4][dictFlag];
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  offset += fcsSize;
  while (true) {
    if (offset + 3 > buffer.length) throw new Error('zstd block header 截断');
    const header = buffer.readUIntLE(offset, 3);
    offset += 3;
    const last = header & 1;
    const type = (header >> 1) & 3;
    const blockSize = header >> 3;
    if (type === 3) throw new Error('zstd block 类型非法');
    offset += type === 1 ? 1 : blockSize;
    if (offset > buffer.length) throw new Error('zstd block 数据截断');
    if (last === 1) break;
  }
  if (hasChecksum) offset += 4;
  return offset;
}

/** 读会话日志首行 header；失败返回 null（调用方按“不确定”保护处理）。 */
function readSessionHeader(logFile) {
  let fd;
  try {
    const size = fs.statSync(logFile).size;
    if (size <= 0) return null;
    fd = fs.openSync(logFile, 'r');
    let wanted = Math.min(size, 64 * 1024);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const buf = Buffer.alloc(wanted);
      const read = fs.readSync(fd, buf, 0, wanted, 0);
      const chunk = buf.subarray(0, read);
      const end = readZstdFrameEnd(chunk, 0);
      const text = zstdDecompressSync(chunk.subarray(0, end)).toString('utf8');
      const line = text.split('\n', 1)[0];
      const header = JSON.parse(line);
      if (header && header.type === 'session') return header;
      return null;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 收集受保护 session id（workspace 索引 / 会话白名单 / 当前调度）
// ---------------------------------------------------------------------------
function collectIds(value, out) {
  if (typeof value === 'string') {
    const m = value.match(/(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (m) out.add('session-' + m[0].replace(/^session-/, ''));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectIds(item, out);
  }
}

function protectedSessionIds() {
  const ids = new Set();
  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  const workspace = readJson(WORKSPACE_STORE);
  if (workspace) {
    collectIds(workspace, ids);
  } else {
    console.warn('[prune] 警告：workspace.json 读取失败，索引保护缺失（将依赖 delegationDepth 兜底）');
  }
  for (const file of [path.join(ROOT, 'state', 'sessions.json'), path.join(ROOT, 'state', 'turn-sender.json')]) {
    const data = readJson(file);
    if (data) collectIds(data, ids);
  }
  return ids;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function moveInto(srcDir, destRoot, name) {
  fs.mkdirSync(destRoot, { recursive: true });
  const dest = path.join(destRoot, name);
  try {
    fs.renameSync(srcDir, dest);
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      fs.cpSync(srcDir, dest, { recursive: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
    } else {
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  if (!fs.existsSync(SESSIONS_ROOT)) {
    console.log(`[prune] 会话根目录不存在：${SESSIONS_ROOT}`);
    return;
  }
  const protectedIds = protectedSessionIds();
  const destRoot = path.join(ROOT, 'state', 'backups', `delegate-sessions-${stamp()}`);
  const cutoff = Date.now() - MIN_AGE_HOURS * 3600 * 1000;
  const summary = { moved: 0, kept: 0, mainProtected: 0, indexedProtected: 0, unknown: 0, skippedWorkspace: 0 };

  for (const slugEntry of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!slugEntry.isDirectory()) continue;
    const slugDir = path.join(SESSIONS_ROOT, slugEntry.name);
    if (slugEntry.name === CURRENT_SLUG) {
      summary.skippedWorkspace += 1;
      continue;
    }
    const candidates = [];
    for (const entry of fs.readdirSync(slugDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
      const dir = path.join(slugDir, entry.name);
      const logFile = path.join(dir, 'session.v4.jsonl.zstd');
      const header = fs.existsSync(logFile) ? readSessionHeader(logFile) : null;
      const id = 'session-' + entry.name.replace(/^session-/, '');
      if (!header) {
        summary.unknown += 1;
        console.log(`[prune] 跳过（无法确认类型）：${entry.name}（${slugEntry.name}）`);
        continue;
      }
      const depth = Number(header.delegationDepth);
      if (!(depth > 0)) {
        summary.mainProtected += 1;
        if (depth === 0) continue;
        summary.unknown += 1;
        console.log(`[prune] 跳过（delegationDepth 异常=${header.delegationDepth}）：${entry.name}（${slugEntry.name}）`);
        continue;
      }
      if (protectedIds.has(id)) {
        summary.indexedProtected += 1;
        continue;
      }
      const stat = fs.statSync(dir);
      candidates.push({ dir, name: entry.name, mtimeMs: stat.mtimeMs });
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    candidates.forEach((item, index) => {
      if (index < KEEP) {
        summary.kept += 1;
        return;
      }
      if (item.mtimeMs >= cutoff) {
        summary.kept += 1;
        return;
      }
      const label = `${item.name}（${slugEntry.name}，${(item.mtimeMs && new Date(item.mtimeMs).toISOString())}）`;
      if (DRY) {
        summary.moved += 1;
        console.log(`[dry] 会移动：${label}`);
        return;
      }
      try {
        moveInto(item.dir, destRoot, item.name);
        summary.moved += 1;
        console.log(`[prune] 已移动：${label}`);
      } catch (error) {
        summary.unknown += 1;
        console.log(`[prune] 移动失败：${label} -> ${error.message}`);
      }
    });
  }

  console.log('');
  console.log(`[prune] ${DRY ? '预览' : '完成'}：移动 ${summary.moved}，保留 ${summary.kept}，主会话保护 ${summary.mainProtected}，索引白名单保护 ${summary.indexedProtected}，跳过未知 ${summary.unknown}，跳过当前工作区 ${summary.skippedWorkspace}`);
  if (summary.moved > 0 && !DRY) console.log(`[prune] 备份目录：${destRoot}`);
  if (DRY) console.log('[prune] 这是预览；去掉 --dry 才会真正移动');
}

main();
