#!/usr/bin/env node
// 记忆文本账本：给每条记忆记一个指纹，证明「没有丢过、没有被悄悄改过」。
// 借鉴《记忆系统实施单》第 5.2 节的做法，套到我们自己的 state/memory/brain.json 上。
//
// 用法：
//   node scripts/memory-ledger.mjs --init     第一次建立账本
//   node scripts/memory-ledger.mjs --sync     把新记忆补进账本（老记录绝不覆盖）
//   node scripts/memory-ledger.mjs --verify   对账：账本里的每条都必须还在、指纹一致
// 退出码：0 通过 / 1 对不上 / 2 读不到
//
// 环境变量（测试用）：MEM_BRAIN、MEM_LEDGER 可指向临时文件。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAIN = path.resolve(process.env.MEM_BRAIN || path.join(REPO_ROOT, 'state/memory/brain.json'));
const LEDGER = path.resolve(process.env.MEM_LEDGER || path.join(REPO_ROOT, 'state/memory/ledger.json'));

const sha = (text) => crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
const fingerprint = (m) => sha(`${m.title ?? ''}\n${m.text ?? ''}`);

function loadBrain() {
  const raw = JSON.parse(fs.readFileSync(BRAIN, 'utf8'));
  const node = raw && typeof raw === 'object' ? raw.memories : null;
  // 我们的 brain.json 里 memories 是「id → 记忆」的对象；也兼容数组形态。
  const list = Array.isArray(node)
    ? node
    : node && typeof node === 'object'
      ? Object.entries(node).map(([id, m]) => ({ id, ...(m || {}) }))
      : Array.isArray(raw)
        ? raw
        : [];
  return list.filter((m) => m && m.id);
}
function loadLedger() {
  if (!fs.existsSync(LEDGER)) return null;
  return JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
}
function saveLedger(entries) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const data = { version: 1, updatedAt: new Date().toISOString(), entries };
  fs.writeFileSync(LEDGER, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
function archiveIds(memories) {
  return new Set(memories.filter((m) => m.status === 'archived').map((m) => m.id));
}

function main() {
  const mode = ['--init', '--sync', '--verify'].find((f) => process.argv.includes(f));
  let memories;
  try {
    memories = loadBrain();
  } catch (error) {
    console.error(`[ledger] 读不到记忆库：${error.message}`);
    return 2;
  }

  const ledger = loadLedger();

  if (mode === '--init') {
    const entries = {};
    for (const m of memories) entries[m.id] = { sha256: fingerprint(m), len: String(m.text ?? '').length };
    saveLedger(entries);
    console.log(`[ledger] 建账完成：${Object.keys(entries).length} 条 → ${path.relative(REPO_ROOT, LEDGER)}`);
    return 0;
  }

  if (!ledger) {
    console.error('[ledger] 还没有账本，先跑 --init');
    return 2;
  }

  const entries = { ...ledger.entries };

  if (mode === '--sync') {
    let added = 0;
    for (const m of memories) {
      if (entries[m.id]) continue; // 老记录绝不覆盖
      entries[m.id] = { sha256: fingerprint(m), len: String(m.text ?? '').length };
      added++;
    }
    if (added) saveLedger(entries);
    console.log(`[ledger] 补齐 ${added} 条，账本共 ${Object.keys(entries).length} 条`);
    return 0;
  }

  // --verify
  const byId = new Map(memories.map((m) => [m.id, m]));
  const archived = archiveIds(memories);
  const missing = [];
  const changed = [];
  for (const [id, rec] of Object.entries(entries)) {
    const m = byId.get(id);
    if (!m) {
      if (!archived.has(id)) missing.push(id);
      continue;
    }
    if (fingerprint(m) !== rec.sha256) changed.push(id);
  }
  const unaccounted = memories.filter((m) => !entries[m.id]).length;

  if (!missing.length && !changed.length) {
    console.log(`[ledger] OK 账本 ${Object.keys(entries).length} 条 · 新记忆未入账 ${unaccounted} 条`);
    return 0;
  }
  if (missing.length) console.error(`[ledger] ❌ 丢了 ${missing.length} 条：${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`);
  if (changed.length) console.error(`[ledger] ❌ 正文被改 ${changed.length} 条：${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ' …' : ''}`);
  console.error('      确认是正常合并/人工修改再重跑 --sync 收编，别直接删账本。');
  return 1;
}

process.exitCode = main();
