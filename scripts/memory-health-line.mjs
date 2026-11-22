#!/usr/bin/env node
// 每日健康一行：总数 / 置顶 / 核心 / 账本状态 / 未入账。
// 借鉴《记忆系统实施单》第 5.3 节，落到我们自己的 brain.json + ledger.json。
//
// 用法：node scripts/memory-health-line.mjs [--append] [--json]
//   --append  追加到 state/memory/health.log（夜间维护里用）
// 退出码：0 正常 / 1 账本对不上 / 2 读不到库

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { salienceScore, salienceTier } from '../src/memory/salience.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAIN = path.join(REPO_ROOT, 'state/memory/brain.json');
const LEDGER = path.join(REPO_ROOT, 'state/memory/ledger.json');
const HEALTH_LOG = path.join(REPO_ROOT, 'state/memory/health.log');

function main() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(BRAIN, 'utf8'));
  } catch (error) {
    console.error(`[health] 读不到记忆库：${error.message}`);
    return 2;
  }
  const node = raw?.memories;
  const list = Array.isArray(node)
    ? node
    : node && typeof node === 'object'
      ? Object.entries(node).map(([id, m]) => ({ id, ...(m || {}) }))
      : [];
  const live = list.filter((m) => m.status !== 'archived');
  const pinned = live.filter((m) => Number(m.protection || 0) >= 1).length;
  // 核心数按关键度现算（tier 不落库）
  const entities = raw?.entities || {};
  const relations = Array.isArray(raw?.relations) ? raw.relations : [];
  const degree = new Map();
  for (const rel of relations) {
    for (const end of [rel.from, rel.to]) {
      if (end) degree.set(end, (degree.get(end) || 0) + 1);
    }
  }
  let core = 0;
  for (const m of live) {
    const entityTypes = {};
    for (const id of Array.isArray(m.entityIds) ? m.entityIds : []) {
      const type = entities[id]?.type || 'other';
      entityTypes[type] = (entityTypes[type] || 0) + 1;
    }
    const score = salienceScore(m, { relations: degree.get(m.id) || 0, entityTypes });
    if (salienceTier(score) === 'core') core += 1;
  }

  let ledgerEntries = {};
  try { ledgerEntries = JSON.parse(fs.readFileSync(LEDGER, 'utf8')).entries || {}; } catch { /* 没账本算 pending 全量 */ }
  const pending = live.filter((m) => !ledgerEntries[m.id]).length;

  let ledgerState = 'MISSING';
  try {
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/memory-ledger.mjs'), '--verify'], { stdio: 'pipe', timeout: 30000 });
    ledgerState = 'OK';
  } catch (error) {
    ledgerState = error?.status === 1 ? 'MISMATCH' : 'ERROR';
  }

  const stamp = new Date().toLocaleString('sv-SE').slice(0, 16);
  const line = `[memory] ${stamp} total=${live.length} pinned=${pinned} core=${core} ledger=${ledgerState} pending=${pending}`;

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ at: stamp, total: live.length, pinned, core, ledger: ledgerState, pending }, null, 2));
  } else {
    console.log(line);
    if (process.argv.includes('--append')) {
      fs.mkdirSync(path.dirname(HEALTH_LOG), { recursive: true });
      fs.appendFileSync(HEALTH_LOG, `${line}\n`, 'utf8');
    }
  }

  // 告警口径：账本对不上、未入账堆太多、置顶滥用
  if (ledgerState !== 'OK') return 1;
  if (pending > 50) console.error(`[health] 警告：未入账 ${pending} 条，消费端可能卡住了`);
  if (pinned > 30) console.error(`[health] 警告：置顶 ${pinned} 条，保护线用得太松`);
  return 0;
}

process.exitCode = main();
