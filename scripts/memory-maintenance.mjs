#!/usr/bin/env node
/**
 * 记忆系统每日维护（建议由 Windows 计划任务每天跑一次）。
 *
 * 做五件事（2026-10-29 起）：
 *   1) `src/memory/cli.mjs decay --json`：物化衰减 / 状态机（active → fading → faded → 归档）
 *   2) `src/memory/cli.mjs consolidate --json`：夜间巩固（short→long、近重复归档、关键词清洗）
 *   2.5) `src/memory/cli.mjs day --date <昨天> --json`：生成昨日「日层」压缩（每天一小段，补时间感）
 *   3) `scripts/memory-vault-refresh.mjs --json`：把 brain.json 重新导出成 Obsidian vault（记忆大脑视图）
 *   4) `scripts/memory-vault-git.mjs --json`：vault 每日 git 快照；结果追加 `state/memory/maintenance.log`
 *
 * 用法：
 *   node scripts/memory-maintenance.mjs            # 正常维护（衰减 + 巩固 + 日层 + 刷新 vault + git 快照）
 *   node scripts/memory-maintenance.mjs --decay-only   # 只衰减/巩固/日层，不刷新 vault
 *   node scripts/memory-maintenance.mjs --vault-only
 *   node scripts/memory-maintenance.mjs --no-git
 *   node scripts/memory-maintenance.mjs --json     # 只输出 JSON 汇总（给计划任务/看板消费）
 *   node scripts/memory-maintenance.mjs --state <dir> --vault <dir> --root <dir>
 *
 * 退出码：0 = 两步都成功（或无可维护数据），1 = 任一步失败。
 *
 * 说明：本脚本只调用既有 CLI，不直接改 brain.json；所有写入由 store 的原子写 + 锁负责。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

const USAGE = `记忆系统每日维护

用法：
  node scripts/memory-maintenance.mjs [选项]

选项：
  --decay-only    只做衰减/巩固，不刷新 vault/不提交 git
  --vault-only    只刷新 vault，不做衰减/巩固
  --no-git        跳过 vault 的 git 快照
  --no-trial      跳过一个月测试台的日报生成
  --json          只输出 JSON 汇总
  --quiet, -q     不打印过程
  --root <dir>    仓库根（默认本脚本上一级）
  --state <dir>   state 目录（默认 <root>/state）
  --vault <dir>   vault 目录（默认 config.vaultDir，相对 state 解析）
  --help, -h      显示本帮助
`;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--decay-only': flags.decayOnly = true; break;
      case '--vault-only': flags.vaultOnly = true; break;
      case '--no-git': flags.noGit = true; break;
      case '--no-trial': flags.noTrial = true; break;
      case '--json': flags.json = true; break;
      case '--quiet': case '-q': flags.quiet = true; break;
      case '--root': flags.root = argv[++i]; break;
      case '--state': flags.state = argv[++i]; break;
      case '--vault': flags.vault = argv[++i]; break;
      case '--help': case '-h': flags.help = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`未知选项：${arg}`);
        throw new Error(`多余参数：${arg}`);
    }
  }
  if (flags.decayOnly && flags.vaultOnly) throw new Error('--decay-only 与 --vault-only 不能同时使用');
  return flags;
}

/** 取命令 stdout 最后一段 JSON（CLI 可能先打印人读文本）。 */
function extractJson(stdout) {
  const lines = String(stdout ?? '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try { return JSON.parse(line); } catch { /* 继续往上找 */ }
  }
  return null;
}

function runStep(label, scriptRel, args, options) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [path.join(options.root, scriptRel), ...args], {
    cwd: options.root,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: { ...process.env, QQ_BRIDGE_MEMORY_MAINTENANCE: '1' },
  });
  const ms = Date.now() - startedAt;
  const ok = result.status === 0;
  const parsed = ok ? extractJson(result.stdout) : null;
  const error = ok
    ? null
    : (String(result.stderr ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')
        || `退出码 ${result.status}`);
  return { label, script: scriptRel, ok, ms, parsed, error };
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) { process.stdout.write(USAGE); return 0; }

  const root = path.resolve(flags.root ?? REPO_ROOT);
  const stateDir = path.resolve(root, flags.state ?? 'state');
  const steps = [];

  if (!flags.vaultOnly) {
    steps.push({ label: 'decay', script: 'src/memory/cli.mjs', args: ['decay', '--root', root, '--state', stateDir, '--json'] });
    steps.push({ label: 'consolidate', script: 'src/memory/cli.mjs', args: ['consolidate', '--root', root, '--state', stateDir, '--json'] });
    // 自述回炉：攒够 30 条才真的压；不够就 skipped 返回 0，不算失败。
    steps.push({ label: 'digest', script: 'src/memory/cli.mjs', args: ['self', '--digest', '--root', root, '--state', stateDir, '--json'] });
    // 文本账本：先 sync 把新记忆补进账本（老记录不覆盖），health 里再 verify 对账。
    steps.push({ label: 'ledger', script: 'scripts/memory-ledger.mjs', args: ['--sync'] });
    const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('sv-SE');
    steps.push({ label: 'day', script: 'src/memory/cli.mjs', args: ['day', '--root', root, '--state', stateDir, '--date', yesterday, '--json'] });
    if (!flags.noTrial) {
      steps.push({ label: 'trial', script: 'src/memory/cli.mjs', args: ['trial', '--root', root, '--state', stateDir, '--report', '--json'] });
    }
    // 每日健康一行：总数/置顶/核心/账本状态/未入账，追加到 state/memory/health.log
    steps.push({ label: 'health', script: 'scripts/memory-health-line.mjs', args: ['--append'] });
  }
  if (!flags.decayOnly) {
    const args = ['--json', '--state', stateDir];
    if (flags.vault) args.push('--vault', path.resolve(flags.vault));
    steps.push({ label: 'vault', script: 'scripts/memory-vault-refresh.mjs', args });
    if (!flags.noGit) {
      const gitArgs = ['--json', '--state', stateDir];
      if (flags.vault) gitArgs.push('--vault', path.resolve(flags.vault));
      steps.push({ label: 'git', script: 'scripts/memory-vault-git.mjs', args: gitArgs });
    }
  }

  const results = [];
  for (const step of steps) {
    const result = runStep(step.label, step.script, step.args, { root });
    results.push(result);
    if (!flags.json && !flags.quiet) {
      const tail = result.ok
        ? (result.parsed ? JSON.stringify(result.parsed).slice(0, 240) : 'ok')
        : `失败：${result.error}`;
      process.stdout.write(`[memory-maintenance] ${result.ok ? '✓' : '✗'} ${step.label} (${result.ms}ms) ${tail}\n`);
    }
  }

  const ok = results.every((r) => r.ok);
  const summary = {
    at: new Date().toISOString(),
    ok,
    steps: results.map((r) => ({ label: r.label, ok: r.ok, ms: r.ms, error: r.error, result: r.parsed })),
  };

  // 维护日志：JSONL 追加，失败也不影响退出码判定（日志写不进去只警告）。
  try {
    const memoryDir = path.join(stateDir, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.appendFileSync(path.join(memoryDir, 'maintenance.log'), `${JSON.stringify(summary)}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`[memory-maintenance] 写维护日志失败（忽略）：${error?.message ?? error}\n`);
  }

  if (flags.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else if (!flags.quiet) {
    process.stdout.write(`[memory-maintenance] ${ok ? '完成' : '有失败项'}（${results.length} 步）\n`);
  }
  return ok ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`[memory-maintenance] ${error?.message ?? error}\n`);
  process.exitCode = 1;
}
