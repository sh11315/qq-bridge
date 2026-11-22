#!/usr/bin/env node
// 记忆系统 —— 运维 CLI（§2：decay / seed <file> / stats / add / search / pin / export-vault）。
//
// 用法：
//   node src/memory/cli.mjs stats
//   node src/memory/cli.mjs decay
//   node src/memory/cli.mjs seed state/memory/seed.json
//   node src/memory/cli.mjs add --text "..." [--title ...] [--layer long|short]
//                                [--category ...] [--keywords a,b] [--tags a,b]
//                                [--entity 名字1,名字2] [--protection 1] [--decay-days 200]
//                                [--source-key group:123]
//   node src/memory/cli.mjs search "关键词" [--entity 名字] [--layer long] [--status fading]
//                                [--limit 10] [--include-faded] [--json]
//   node src/memory/cli.mjs pin --id mem_xxxx | --query "关键词" [--protection 1|0] [--note "..."]
//   node src/memory/cli.mjs export-vault [--out 路径] [--vault 路径]
//
// 全局参数：--root <仓库根>（默认 src/memory 往上两级；测试用），--state <state 目录>。
// 所有输出走 stdout/stderr（CLI 不是 MCP 协议进程，不受“stdout 只走协议”限制）。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MemoryError } from './model.mjs';
import { createService } from './service.mjs';

const USAGE = `记忆系统运维 CLI

用法：
  node src/memory/cli.mjs <命令> [选项]

命令：
  stats                       打印记忆库统计（§6.10 同源数据）
  state                       打印当前人格状态（精力/心情；感受词 + 内部数值）
  set-state                   设定状态：--energy 0~1 / --mood -1~1 / --reason 说明（至少一个）
  self                        自述与人设：不带参数=查看；--text "…"=写一条自述（只增不改）
                              --anchor "…"=改人设锚点；--digest [--force]=回炉自述
                              --persona "…"=提交人设建议（待主人批准）；--approve/--reject=批准/驳回
  value                       记一条「在乎的」：--text "…" 必填（或位置参数）
  emotion                     查看当前情绪（24h 内有效）与最近历史（感受词，不念数值）
  set-emotion                 记一条情绪：--label 烦躁/低落/平静/开心/疲惫/紧张/兴奋/委屈
                              --intensity 0~1（可选）--note 说明（可选）
  proposals                   查看自升级提案：不带参数=全部；--status pending/approved/rejected
  decide                      主人批准/驳回提案：--id prop_xxx --status approved|rejected [--score 0~1]
  self-review                 按外部卡尺扫最近自己的话：--days 7 --dry-run（不加 --dry-run 才写入提案）
  trial                       一个月测试台：查看进度；--init 启动/沿用；--report 生成报告
  day                         日层压缩：把某一天压成一小段摘要（--date YYYY-MM-DD，默认昨天；
                              --dry-run 预览，--force 覆盖已有日层）
  decay                       物化衰减/状态机，把过期边缘记忆归档（不再物理删除，每日维护用）
  consolidate                 夜间巩固：short→long 提升、近重复归档、关键词清洗（写 metrics）
compact                    把增量 journal 合并回 brain.json（回滚/维护前用）
  ingest                      零 LLM 抽取入库：把一段文字按规则抽成候选事实逐条 remember
                              --text 必填（或位置参数），--max N（1~10），--dry-run 只看候选
  seed <file|->               导入 seed.json（- 表示从 stdin 读），幂等
  add                         新增一条记忆：--text 必填，可选 --title/--layer/--category
                              /--keywords a,b/--tags a,b/--entity 名字1,名字2
                              /--protection 0~1/--decay-days N/--source-key <key>
                              /--supersedes id1,id2（显式声明取代哪些旧记忆）
  search [关键词]             只读检索（不重置衰减）：--query/--entity/--layer/--status
                              /--date YYYY-MM-DD/--since/--until/--category
                              /--depth 0~3（扩散激活深度，默认 1）
                              /--include-faded/--include-superseded/--json
  pin                         固定/取消固定：--id 或 --query，--protection 默认 1，
                              --note 备注
  export-vault                导出 brain 快照 JSON（供 vault 刷新/调试）：--out 路径
                              --vault 目录

全局选项：
  --root <dir>                仓库根（默认从本文件位置推导）
  --state <dir>               state 目录（默认 <root>/state）
  --json                      以 JSON 输出结果（stats/add/search/pin/decay/seed/export-vault 支持）
`;

function splitList(value) {
  if (value === undefined || value === null || value === true || value === false) return undefined;
  return String(value)
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[index + 1];
        if (next !== undefined && next !== null && !String(next).startsWith('--')) {
          flags[key] = String(next);
          index += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** 默认仓库根：cli.mjs 在 src/memory/ 下，往上两级；环境变量可覆盖（测试隔离用）。 */
function detectRepoRoot(cliFile = process.argv[1]) {
  const fromEnv = process.env.QQBRIDGE_MEMORY_ROOT || process.env.QQBRIDGE_REPO_ROOT;
  if (fromEnv) return path.resolve(fromEnv);
  try {
    const file = path.resolve(cliFile || process.cwd());
    const parent = path.dirname(file);
    if (path.basename(parent) === 'memory' && path.basename(path.dirname(parent)) === 'src') {
      return path.resolve(parent, '..', '..');
    }
    return path.dirname(file);
  } catch {
    return process.cwd();
  }
}

function numberFlag(value, fallback = undefined) {
  if (value === undefined || value === null || value === true || value === false) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * 执行 CLI 命令。
 * @param {string[]} argv 命令参数（不含 node 与脚本路径）
 * @param {{cwd?: string, stdout?: (line: string) => void, stderr?: (line: string) => void, cliFile?: string, env?: object}} [io]
 * @returns {number} 退出码
 */
export function runCli(argv = process.argv.slice(2), io = {}) {
  const out = io.stdout ?? ((line) => console.log(line));
  const err = io.stderr ?? ((line) => console.error(line));
  const { positional, flags } = parseArgs(argv);
  const [command = 'help', ...rest] = positional;

  if (command === 'help' || command === '--help' || flags.help) {
    out(USAGE);
    return 0;
  }

  let repoRoot;
  let stateDir;
  try {
    repoRoot = flags.root ? path.resolve(String(flags.root)) : detectRepoRoot(io.cliFile);
    stateDir = flags.state ? path.resolve(String(flags.state)) : undefined;
    if (io.cwd && !flags.root) repoRoot = path.resolve(io.cwd, repoRoot);
  } catch (error) {
    err(`错误：无法确定仓库根：${error?.message ?? error}`);
    return 1;
  }

  let service;
  try {
    service = createService({ repoRoot, stateDir });
  } catch (error) {
    err(`错误：${error?.message ?? error}`);
    return 1;
  }

  const json = flags.json === true;

  try {
    switch (command) {
      case 'stats': {
        const stats = service.stats();
        if (json) {
          printJson(stats);
        } else {
          const paths = service.paths();
          out(`记忆库：${paths.brainPath}`);
          out(`总记忆：${stats.total}（long ${stats.byLayer.long} / short ${stats.byLayer.short} / 日记 ${stats.diary ?? 0}）`);
          if (stats.capacity) out(`配额：long ${stats.capacity.long} / short ${stats.capacity.short}（按层独立淘汰，long 不再被 short 挤掉）`);
          out('日记：单独归档在 vault 的 日记/ 目录，不参与衰减与清理');
          out(
            `状态：active ${stats.active} / fading ${stats.fading} / faded ${stats.faded} / archived ${stats.archived} / superseded ${stats.superseded ?? 0}；永久 ${stats.permanent}`
          );
          out(`实体 ${stats.entities} 个，关系 ${stats.relations} 条，共激活突触 ${stats.synapses ?? 0} 条（强突触 ${stats.strongSynapses ?? 0}）；矛盾降权 ${stats.deprioritized ?? 0} 条`);
          const tier = stats.byTier || {};
          out(`分层：工作 ${tier.working ?? 0} / 短期 ${tier['short-term'] ?? 0} / 情景 ${tier.episodic ?? 0} / 长期 ${tier['long-term'] ?? 0}（只读视图，不改衰减）`);
          const groups = stats.relationGroups || {};
          const activeGroups = Object.values(groups).filter((v) => Number(v) > 0).length;
          out(`关系大类：${activeGroups} / 5 类（时间 ${groups.temporal ?? 0} / 因果 ${groups.causal ?? 0} / 语义 ${groups.semantic ?? 0} / 情绪 ${groups.emotional ?? 0} / 冲突 ${groups.conflict ?? 0} / 旧式 ${groups.legacy ?? 0}）`);
          out(`衰减：long ${stats.decayDays.long} 天 / short ${stats.decayDays.short} 天；保护线 ${stats.protectionLine}`);
          out(`vault：${stats.vaultDir}`);
          out(`提示：${stats.nextDecayHint}`);
        }
        return 0;
      }
      case 'state': {
        const result = service.state();
        const state = result.state;
        if (json) {
          printJson(result);
        } else {
          out(`精力：${state.energyWord}（${state.energy}）  心情：${state.moodWord}（${state.mood}）`);
          out(`昼夜基线 ${state.baseline}；距上次更新 ${state.hours} 小时；注入提示词时只用感受词，不用数值`);
        }
        return 0;
      }
      case 'set-state': {
        const patchArgs = {};
        if (flags.energy !== undefined) patchArgs.energy = Number(flags.energy);
        if (flags.mood !== undefined) patchArgs.mood = Number(flags.mood);
        if (flags.reason !== undefined) patchArgs.reason = String(flags.reason);
        const result = service.updateState(patchArgs);
        if (json) {
          printJson(result);
        } else {
          out(`状态已更新：精力 ${result.state.energyWord}（${result.state.energy}） / 心情 ${result.state.moodWord}（${result.state.mood}）`);
        }
        return 0;
      }
      case 'emotion': {
        const result = service.emotion();
        if (json) {
          printJson(result);
        } else {
          out(result.emotion
            ? `当前情绪：${result.emotion.label}（强度 ${result.emotion.intensity}，${result.prompt || '需复读'}）`
            : '当前没有有效情绪（24h 内没有记录）');
          if (result.history.length) out(`历史：${result.history.map((item) => item.label).join(' / ')}`);
        }
        return 0;
      }
      case 'set-emotion': {
        const raw = {
          label: flags.label && flags.label !== true ? String(flags.label) : undefined,
          intensity: numberFlag(flags.intensity, undefined),
          note: flags.note && flags.note !== true ? String(flags.note) : undefined,
        };
        const result = service.setEmotion(raw);
        if (json) printJson(result);
        else out(`已记下情绪：${result.emotion.label}（${result.prompt || '—'}），过期后自动不再复读`);
        return 0;
      }
      case 'proposals': {
        const result = service.proposals({ status: flags.status && flags.status !== true ? String(flags.status) : undefined });
        if (json) {
          printJson(result);
        } else {
          out(`提案：待批准 ${result.counts.pending} / 已批准 ${result.counts.approved} / 已驳回 ${result.counts.rejected}`);
          for (const item of [...result.pending, ...result.decided].slice(0, 10)) {
            out(`  · [${item.status}] ${item.id} ${item.title}`);
          }
        }
        return 0;
      }
      case 'decide': {
        const id = flags.id && flags.id !== true ? String(flags.id) : undefined;
        const status = flags.status && flags.status !== true ? String(flags.status) : 'approved';
        const result = service.resolveProposal({ id, status, by: 'owner', externalScore: numberFlag(flags.score, undefined) });
        if (json) printJson(result);
        else out(`提案 ${result.proposal.id} 已${result.proposal.status === 'approved' ? '批准' : '驳回'}，生效语气提示 ${result.toneHints.length} 条`);
        return 0;
      }
      case 'self-review': {
        const result = service.selfReview({ days: numberFlag(flags.days, 7), dryRun: flags['dry-run'] === true });
        if (json) printJson(result);
        else {
          out(`自评扫描 ${result.scanned} 条，发现候选 ${result.proposals.length} 条（${result.dryRun ? '只预览' : '已写入待批准'}）`);
          for (const item of result.proposals.slice(0, 5)) out(`  · ${item.title}（自评嫌疑 ${item.selfScore}，不算数）`);
        }
        return 0;
      }
      case 'trial': {
        const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
        const script = path.join(scriptRoot, 'scripts', 'memory-trial.mjs');
        const baseArgs = ['--root', repoRoot, ...(stateDir ? ['--state', stateDir] : [])];
        if (flags.init === true) {
          execFileSync(process.execPath, [script, '--init', ...baseArgs], { stdio: 'inherit' });
          return 0;
        }
        if (flags.report === true) {
          execFileSync(process.execPath, [script, '--report', ...baseArgs, ...(json ? ['--json'] : [])], { stdio: 'inherit' });
          return 0;
        }
        const result = service.trialInfo();
        if (json) printJson(result);
        else {
          if (!result.trial) out('一个月测试台还没启动：node src/memory/cli.mjs trial --init');
          else out(`测试台：开始 ${new Date(result.trial.startedAt).toLocaleString()}，${result.trial.durationDays || 30} 天`);
          if (result.report) out(`报告：唤醒 ${result.report.wakes?.total ?? 0} 次，探针命中 ${result.report.probe?.found ? '是' : '否'}`);
        }
        return 0;
      }
      case 'decay':
      case 'materialize': {
        const result = service.materialize();
        if (json) {
          printJson(result);
        } else {
          out(`已物化衰减：当前 ${result.total} 条记忆，本次归档 ${result.archived.length} 条过期边缘记忆`);
          if (result.archived.length) out(`归档：${result.archived.join(', ')}`);
          out(`提示：${result.stats.nextDecayHint}`);
        }
        return 0;
      }
      case 'compact': {
        const result = service.compact();
        if (json) printJson(result);
        else out(`已 compact：${result.compacted ? '已合并 journal' : '无 journal 可合并'}（${result.journalBytes ?? 0} 字节）`);
        return 0;
      }
      case 'consolidate': {
        const result = service.consolidate();
        if (json) {
          printJson(result);
        } else {
          out(`已巩固记忆：共 ${result.total} 条`);
          out(`- short→long 提升：${result.promoted}`);
          out(`- 近重复归档：${result.deduped}（重复率 ${result.duplicateRate}）`);
          out(`- 关键词清洗：${result.keywordCleaned} 条`);
          out(`- 同主题时间合并：${result.timeMerged ?? 0} 条（保留最新 ${result.progressKeep ?? 3} 条 + 一条摘要）`);
          if (result.dedupedItems.length) {
            for (const item of result.dedupedItems.slice(0, 10)) out(`  · ${item.id} → 合并进 ${item.mergedInto}（相似度 ${item.similarity}）`);
          }
          out(`指标已写入：${result && result.at ? 'state/memory/last-consolidation.json' : 'state/memory/last-consolidation.json'}`);
        }
        return 0;
      }
      case 'seed': {
        const file = rest[0] ?? (flags.file && flags.file !== true ? String(flags.file) : null);
        let raw;
        if (file === '-' || flags.stdin === true) {
          raw = fs.readFileSync(0, 'utf8');
        } else if (file) {
          raw = fs.readFileSync(path.resolve(file), 'utf8');
        } else {
          err('错误：seed 需要文件路径（或 - 从 stdin 读）');
          return 1;
        }
        let data;
        try {
          data = JSON.parse(raw);
        } catch (error) {
          err(`错误：seed 文件不是合法 JSON：${error?.message ?? error}`);
          return 1;
        }
        const result = service.seed(data);
        if (json) {
          printJson(result);
        } else {
          out(
            `seed 完成：实体 +${result.entities.created}/~${result.entities.updated}，关系 +${result.relations.created}/~${result.relations.updated}，记忆 +${result.memories.created}/合并 ${result.memories.merged}`
          );
          if (result.skipped) out(`跳过 ${result.skipped} 条`);
          for (const message of result.errors.slice(0, 10)) err(`  - ${message}`);
          out(`当前共 ${result.stats.total} 条记忆、${result.stats.entities} 个实体`);
        }
        return 0;
      }
      case 'add':
      case 'remember': {
        const text =
          flags.text !== undefined && flags.text !== true ? String(flags.text) : rest.join(' ').trim() || undefined;
        if (!text) {
          err('错误：add 需要 --text "记忆内容"');
          return 1;
        }
        const input = {
          text,
          title: flags.title && flags.title !== true ? String(flags.title) : undefined,
          layer: flags.layer && flags.layer !== true ? String(flags.layer) : undefined,
          category: flags.category && flags.category !== true ? String(flags.category) : undefined,
          keywords: splitList(flags.keywords),
          tags: splitList(flags.tags),
          entityNames: splitList(flags.entity ?? flags.entities),
          supersedes: splitList(flags.supersedes ?? flags.supersede),
          protection: numberFlag(flags.protection, undefined),
          decayDays: numberFlag(flags['decay-days'] ?? flags.decayDays, undefined),
          source:
            flags['source-key'] || flags['source-kind']
              ? {
                  key: flags['source-key'] && flags['source-key'] !== true ? String(flags['source-key']) : 'cli',
                  kind: flags['source-kind'] && flags['source-kind'] !== true ? String(flags['source-kind']) : 'manual',
                }
              : undefined,
        };
        const result = service.remember(input);
        if (json) {
          printJson(result);
        } else {
          out(result.created ? `已记住：${result.memory.title}（${result.id}）` : `已合并到已有记忆：${result.memory.title}（${result.id}）`);
          out(`  强度 ${result.memory.strength}，层级 ${result.memory.layer}，状态 ${result.memory.status}`);
          if (result.superseded?.length) out(`  同时把 ${result.superseded.length} 条旧记忆标记为已取代：${result.superseded.join(', ')}`);
        }
        return 0;
      }
      case 'ingest': {
        const text =
          flags.text !== undefined && flags.text !== true ? String(flags.text) : rest.join(' ').trim() || undefined;
        if (!text) {
          err('错误：ingest 需要 --text "一段对话/笔记"');
          return 1;
        }
        const result = service.ingest({
          text,
          max: numberFlag(flags.max, undefined),
          layer: flags.layer && flags.layer !== true ? String(flags.layer) : undefined,
          dryRun: flags['dry-run'] === true || flags.dryRun === true,
        });
        if (json) {
          printJson(result);
        } else {
          out(`抽取候选 ${result.candidates.length} 条${result.dryRun ? '（dry-run，未落库）' : ''}：`);
          result.candidates.forEach((candidate, index) => {
            out(`  ${index + 1}. [${candidate.kind}/${candidate.category}] ${candidate.text}`);
          });
          if (!result.dryRun) {
            out(`入库：新增 ${result.created} 条，合并 ${result.merged} 条`);
            if (result.superseded.length) out(`矛盾降权：${result.superseded.join(', ')}`);
          }
        }
        return 0;
      }
      case 'search': {
        const query =
          flags.query !== undefined && flags.query !== true ? String(flags.query) : rest.join(' ').trim() || '';
        const status = flags.status && flags.status !== true ? String(flags.status) : undefined;
        const result = service.search({
          query,
          entity: flags.entity && flags.entity !== true ? String(flags.entity) : undefined,
          layer: flags.layer && flags.layer !== true ? String(flags.layer) : undefined,
          status,
          date: flags.date && flags.date !== true ? String(flags.date) : undefined,
          since: flags.since && flags.since !== true ? String(flags.since) : undefined,
          until: flags.until && flags.until !== true ? String(flags.until) : undefined,
          category: flags.category && flags.category !== true ? String(flags.category) : undefined,
          depth: numberFlag(flags.depth, undefined),
          limit: numberFlag(flags.limit, undefined),
          includeFaded: flags['include-faded'] === true,
          includeSuperseded: flags['include-superseded'] === true,
        });
        if (json) {
          printJson(result);
        } else if (!result.memories.length) {
          out('没有找到匹配的记忆。');
        } else {
          out(`找到 ${result.memories.length} 条（命中 ${result.total} 条，扩散深度 ${result.depth} / ${result.depthProfile?.name ?? 'Context'}，激活 ${result.activated ?? 0} 条）：`);
          result.memories.forEach((memory, index) => {
            out(
              `${index + 1}. [${memory.id}] 强度 ${memory.strength.toFixed(2)} · ${memory.layer} · ${memory.status} · ${memory.title}`
            );
            out(`   ${memory.text}`);
          });
        }
        return 0;
      }
      case 'pin': {
        const targetId = flags.id && flags.id !== true ? String(flags.id) : undefined;
        const query = flags.query && flags.query !== true ? String(flags.query) : rest.join(' ').trim() || undefined;
        const result = service.pin({
          id: targetId,
          query,
          protection: numberFlag(flags.protection, 1),
          note: flags.note && flags.note !== true ? String(flags.note) : undefined,
        });
        if (json) {
          printJson(result);
        } else {
          out(
            result.permanent
              ? `已固定为永久记忆：${result.id}（protection=${result.protection}）`
              : `已取消永久：${result.id}（protection=${result.protection}）`
          );
          if (result.note) out(`备注：${result.note}`);
        }
        return 0;
      }
﻿      case 'self': {
        if (flags.anchor) {
          const text = flags.anchor === true ? positional.slice(1).join(' ') : String(flags.anchor);
          const result = service.setAnchor({ text });
          if (json) printJson(result);
          else out(`人设锚点已更新：${result.anchor}`);
          return 0;
        }
        if (flags.digest === true) {
          const result = service.selfDigest({ force: flags.force === true, dryRun: flags['dry-run'] === true });
          if (json) printJson(result);
          else if (result.dryRun) { out(`[预览] 共 ${result.count} 条自述`); out(result.text); }
          else if (result.skipped) out(`自述还不够（${result.total} 条，至少 ${result.min} 条）；加 --force 可强制回炉`);
          else { out(`已回炉：${result.count} 条 → 第 ${result.total} 段`); out(result.digest.text); }
          return 0;
        }
        if (flags.approve === true || flags.reject === true) {
          const result = service.resolvePersona({ status: flags.approve === true ? 'approved' : 'rejected' });
          if (json) printJson(result);
          else out(`人设建议已${flags.approve === true ? '批准' : '驳回'}：${result.persona.text}`);
          return 0;
        }
        if (flags.persona) {
          const result = service.setPersona({ text: flags.persona === true ? '' : String(flags.persona) });
          if (json) printJson(result);
          else out(`已提交人设建议（待主人批准）：${result.persona.text}`);
          return 0;
        }
        const extra = positional.slice(1);
        if (flags.text || extra.length) {
          const text = flags.text && flags.text !== true ? String(flags.text) : extra.join(' ');
          const result = service.addSelfNarrative({ text });
          if (json) printJson(result);
          else out(`已写进自述：${result.narrative.id}（共 ${result.total} 条；只增不改）`);
          return 0;
        }
        {
          const result = service.narratives({ limit: numberFlag(flags.limit, 20) });
          if (json) {
            printJson(result);
          } else {
            out(`自述：${result.total} 条（只增不改）`);
            for (const item of result.items) out(`  ${new Date(item.at).toLocaleString()}  ${item.text}`);
            if (result.anchor) out(`人设锚点：${result.anchor}`);
            const values = Array.isArray(result.values) ? result.values : [];
            if (values.length) {
              out(`在乎的：${values.length} 条`);
              for (const item of values.slice(0, 8)) out(`  - ${item.text}`);
            }
            const digests = Array.isArray(result.digests) ? result.digests : [];
            if (digests.length) {
              const last = digests[0];
              out(`自述·回炉：${digests.length} 段，最近 ${new Date(last.at).toLocaleString()}（${last.count} 条）`);
              out(`  ${String(last.text).split('\n').join(' ').slice(0, 160)}`);
            }
            const persona = result.persona;
            out(`人设建议：${persona.status === 'none' || !persona.text ? '（无）' : `[${persona.status}] ${persona.text}`}`);
          }
          return 0;
        }
      }
      case 'value': {
        if (flags.text || positional.length > 1) {
          const text = flags.text && flags.text !== true ? String(flags.text) : positional.slice(1).join(' ');
          const result = service.addValue({ text });
          if (json) printJson(result);
          else out(`已记下一条「在乎的」（共 ${result.total} 条）`);
          return 0;
        }
        const result = service.narratives({ limit: 1 });
        if (json) printJson({ ok: true, values: result.values });
        else {
          out(`在乎的：${result.values.length} 条`);
          for (const item of result.values) out(`  - ${item.text}`);
        }
        return 0;
      }

      case 'day': {
        const result = service.dayDigest({
          date: flags.date && flags.date !== true ? String(flags.date) : undefined,
          dryRun: flags['dry-run'] === true,
          force: flags.force === true,
        });
        if (json) printJson(result);
        else if (result.dryRun) {
          out(`[预览] ${result.date} 共 ${result.count} 条记录`);
          out(result.text);
        } else if (result.skipped) {
          out(`日层已存在，跳过：${result.id}（${result.date}）`);
        } else {
          out(`已生成日层：${result.date}（${result.count} 条记录）${result.id ? ` → ${result.id}` : ''}`);
        }
        return 0;
      }

      case 'export-vault': {
        const { brain, vaultDir } = service.vaultContext();
        const outputPath = path.resolve(
          flags.out && flags.out !== true ? String(flags.out) : path.join(service.paths().memoryDir, 'vault-export.json')
        );
        const targetVault = path.resolve(flags.vault && flags.vault !== true ? String(flags.vault) : vaultDir);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const payload = {
          generatedAt: Date.now(),
          vaultDir: targetVault,
          brain,
        };
        fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        if (json) {
          printJson({ ok: true, out: outputPath, vaultDir: targetVault, memories: Object.keys(brain.memories).length });
        } else {
          out(`已导出 vault 数据：${outputPath}`);
          out(`目标 vault：${targetVault}`);
          out(`包含 ${Object.keys(brain.memories).length} 条记忆、${Object.keys(brain.entities).length} 个实体、${brain.relations.length} 条关系`);
        }
        return 0;
      }
      default: {
        err(`错误：未知命令「${command}」\n`);
        err(USAGE);
        return 1;
      }
    }
  } catch (error) {
    if (error instanceof MemoryError) {
      err(`错误：${error.message}`);
      return 1;
    }
    err(`错误：${error?.stack ?? error}`);
    return 1;
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && /(?:^|[\\/])cli\.mjs$/.test(path.resolve(process.argv[1]));
if (invokedDirectly) {
  const code = runCli();
  if (code) process.exitCode = code;
}

export { detectRepoRoot, parseArgs };
