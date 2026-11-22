// 关键度体检：把记忆库按 salienceScore 排一遍，看「哪些真的压得住」。
// 用法：node scripts/salience-report.mjs [--top 12] [--all]
import fs from 'node:fs';
import path from 'node:path';
import { salienceScore, salienceTier, SALIENCE_TIERS } from '../src/memory/salience.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAIN = path.join(ROOT, 'state', 'memory', 'brain.json');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};
const top = flag('--top', 12);
const showAll = argv.includes('--all');

const brain = JSON.parse(fs.readFileSync(BRAIN, 'utf8'));
const entities = brain.entities || {};
const relations = Array.isArray(brain.relations) ? brain.relations : [];
const memories = Object.values(brain.memories || {}).filter(
  (m) => m && m.status !== 'archived' && m.status !== 'superseded'
);

// 每条记忆在关系图里的度数
const degree = new Map();
for (const rel of relations) {
  for (const end of [rel.from, rel.to]) {
    if (end) degree.set(end, (degree.get(end) || 0) + 1);
  }
}

function ctxOf(memory) {
  const entityTypes = {};
  for (const id of Array.isArray(memory.entityIds) ? memory.entityIds : []) {
    const type = entities[id]?.type || 'other';
    entityTypes[type] = (entityTypes[type] || 0) + 1;
  }
  return { relations: degree.get(memory.id) || 0, entityTypes };
}

const scored = memories
  .map((memory) => ({
    memory,
    score: salienceScore(memory, ctxOf(memory)),
    tier: salienceTier(salienceScore(memory, ctxOf(memory))),
  }))
  .sort((a, b) => b.score - a.score);

const counts = { core: 0, important: 0, normal: 0 };
for (const item of scored) counts[item.tier] += 1;

console.log(`记忆 ${memories.length} 条 · 核心 ${counts.core} / 重要 ${counts.important} / 普通 ${counts.normal}`);
console.log(`阈值：核心 ≥ ${SALIENCE_TIERS.core.min} · 重要 ≥ ${SALIENCE_TIERS.important.min}`);
console.log('');

const rows = showAll ? scored : scored.slice(0, top);
for (const { memory, score, tier } of rows) {
  const pin = Number(memory.protection) >= 1 ? '📌' : '  ';
  const title = String(memory.title || memory.text || '').slice(0, 28);
  console.log(`${pin} ${score.toFixed(3)} [${tier}] ${memory.layer}/${memory.category} ${title}`);
}

if (!showAll) {
  const tail = scored.slice(-3).reverse();
  console.log('\n最轻的几条：');
  for (const { memory, score, tier } of tail) {
    const title = String(memory.title || memory.text || '').slice(0, 28);
    console.log(`   ${score.toFixed(3)} [${tier}] ${memory.layer}/${memory.category} ${title}`);
  }
}

if (argv.includes('--hist')) {
  const buckets = new Array(10).fill(0);
  for (const item of scored) buckets[Math.min(9, Math.floor(item.score * 10))] += 1;
  console.log('\n分数分布：');
  buckets.forEach((n, i) => {
    const from = (i / 10).toFixed(1);
    const to = ((i + 1) / 10).toFixed(1);
    console.log(`  ${from}~${to} ${'█'.repeat(Math.min(40, n))} ${n}`);
  });
}
