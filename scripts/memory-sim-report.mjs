#!/usr/bin/env node
/**
 * 读取 state/memory/sim-report-*.json，打印可在终端直接查看的对照表。
 *
 * 用法：
 *   node scripts/memory-sim-report.mjs
 *   node scripts/memory-sim-report.mjs state/memory/sim-report-200k.json
 *   node scripts/memory-sim-report.mjs --json        # 输出 JSON（给别的工具用）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPORTS = [
  'state/memory/sim-report-200k.json',
  'state/memory/sim-report-200k-nocap.json',
];

function loadReport(file) {
  const full = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!fs.existsSync(full)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    return { file: full, report: raw.report || raw, probe: raw.probe || null };
  } catch (error) {
    return { file: full, error: error.message };
  }
}

function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function num(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function mb(bytes) {
  return `${(Number(bytes || 0) / 1024 / 1024).toFixed(2)} MB`;
}

function row(cells) {
  return `| ${cells.join(' | ')} |`;
}

function printOne(loaded) {
  if (!loaded) return;
  if (loaded.error) {
    console.log(`读取失败：${loaded.file} — ${loaded.error}`);
    return;
  }
  const r = loaded.report;
  const m = r.memory || {};
  const q = r.recall || {};
  console.log('');
  console.log(`■ ${path.basename(loaded.file)}`);
  console.log(`  生成时间：${r.generatedAt || '-'}　语料：${num(r.corpus?.messages)} 条 / ${r.corpus?.days} 天（${num(r.corpus?.perDay)}/天，seed ${r.corpus?.seed}）`);
  const capText = r.config?.capLong ? `long 配额 ${num(r.config.capLong)} / short 配额 ${num(r.config.capShort)}` : `maxMemories=${num(r.config?.cap)}`;
  console.log(`  配置：${capText}，长/短衰减 ${r.config?.decayDaysLong}/${r.config?.decayDaysShort} 天`);
  console.log(`  形成：新建 ${num(m.created)}（${pct((m.createdPerMessage || 0) * 100)}/消息）、去重合并 ${num(m.merged)}、矛盾降权 ${num(m.superseded)}`);
  const capacityDetail = m.archivedCapacityLong != null ? `（long ${num(m.archivedCapacityLong)} / short ${num(m.archivedCapacityShort)}）` : '';
  console.log(`  淘汰：容量 ${num(m.archivedCapacity)}${capacityDetail}、衰减 ${num(m.archivedDecay)}、近重复 ${num(m.archivedDuplicate)}`);
  const activeDetail = m.activeLong != null ? `（long ${num(m.activeLong)} / short ${num(m.activeShort)}）` : '';
  console.log(`  规模：活跃 ${num(m.active)}${activeDetail}、归档 ${num(m.archived)}、brain ${mb(m.journalBytes)}（${m.perMessageBytes || '-'} B/消息）、突触 ${num(m.synapses)}`);
  console.log(`  召回：主题 ${num(q.topicQueries)} 次命中 ${pct(q.topicHitRate)}；最近决策 ${num(q.decisionQueries)} 次命中 ${pct(q.decisionHitRate)}；随机目标参考 ${num(q.queries)} 次命中 ${pct(q.hitRate)}；P50 ${q.latencyMs?.p50}ms / P95 ${q.latencyMs?.p95}ms`);
  const ages = Object.entries(q.byAge || {}).filter(([, v]) => Number(v?.queries) > 0);
  if (ages.length) console.log(`  按年龄：${ages.map(([k, v]) => `${k} ${pct(v.hitRate)}（${num(v.queries)} 次）`).join(' / ')}`);
  if (Array.isArray(r.survival) && r.survival.length) {
    console.log(`  存活：${r.survival.map((s) => `第 ${Number(s.day) + 1} 天出生 ${num(s.created)} 条 → 活跃 ${pct(s.rate)}`).join('；')}`);
  }
  if (Array.isArray(r.activeOverTime) && r.activeOverTime.length) {
    const step = Math.max(1, Math.floor(r.activeOverTime.length / 6));
    const samples = r.activeOverTime.filter((_, i) => i % step === 0).map((x) => `D${x.day}:${num(x.active)}`);
    console.log(`  活跃曲线：${samples.join(' → ')} → 最终 ${num(m.active)}`);
  }
  console.log(`  速度：${num(r.throughputPerSec)} 消息/秒，总耗时 ${((r.elapsedMs || 0) / 1000).toFixed(1)}s`);
  if (loaded.probe) {
    console.log(`  真机对照：MemoryService 写 ${num(loaded.probe.count)} 条 ${loaded.probe.elapsedMs}ms（${loaded.probe.perWriteMs}ms/条）`);
  }
}

function printCompare(loadedList) {
  const valid = loadedList.filter((x) => x && !x.error && x.report);
  if (valid.length < 2) return;
  console.log('');
  console.log('■ 对照表');
  console.log('');
  console.log(row(['指标', ...valid.map((x) => path.basename(x.file).replace(/^sim-report-|\.json$/g, ''))]));
  console.log(row(valid.map(() => '---').length === valid.length ? ['---', ...valid.map(() => '---')] : []));
  const rows = [
    ['新建记忆', (r) => num(r.memory.created)],
    ['去重合并', (r) => num(r.memory.merged)],
    ['容量淘汰', (r) => num(r.memory.archivedCapacity)],
    ['衰减归档', (r) => num(r.memory.archivedDecay)],
    ['最终活跃', (r) => num(r.memory.active)],
    ['brain 体积', (r) => mb(r.memory.journalBytes)],
    ['决策召回', (r) => pct(r.recall.decisionHitRate)],
    ['随机目标召回', (r) => pct(r.recall.hitRate)],
    ['召回 P50', (r) => `${r.recall.latencyMs?.p50}ms`],
    ['第 1 天存活', (r) => pct((r.survival || [])[0]?.rate)],
  ];
  for (const [label, get] of rows) console.log(row([label, ...valid.map((x) => get(x.report))]));
}

function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));
  const targets = files.length ? files : DEFAULT_REPORTS;
  const loaded = targets.map(loadReport);
  if (jsonMode) {
    console.log(JSON.stringify(loaded.map((x) => (x ? { file: x.file, report: x.report, probe: x.probe } : null)), null, 2));
    return;
  }
  console.log('记忆网络仿真报告');
  let printed = 0;
  for (const item of loaded) {
    if (!item) {
      console.log(`（未找到报告：${item}）`);
      continue;
    }
    printOne(item);
    printed += 1;
  }
  if (!printed) {
    console.log('没有找到报告。先运行：');
    console.log('  node scripts/memory-sim.mjs --messages 200000 --days 60 --seed 42 --json-out state/memory/sim-report-200k.json');
    return;
  }
  printCompare(loaded);
  console.log('');
  console.log('完整说明：docs/guides/MEMORY_SIM.md');
}

main();
