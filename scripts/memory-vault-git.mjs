#!/usr/bin/env node
/**
 * 记忆 vault 的每日 git 快照（机器人蓝图：加个 git 每天一提交，库坏能回滚）。
 *
 * 做一件事：确保 vault 目录是一个 git 仓库（首次自动 git init），把当天生成/删除的笔记
 * 全部提交。vault 本身是自动生成物，本脚本只负责快照，不参与记忆数据源。
 *
 * 用法：
 *   node scripts/memory-vault-git.mjs [--vault <dir>] [--state <dir>] [--json] [--quiet]
 * 退出码：0 = 成功（含无改动/跳过）；1 = git 操作失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

const USAGE = `记忆 vault git 快照

用法：
  node scripts/memory-vault-git.mjs [选项]

选项：
  --vault <dir>    vault 目录（默认读 state/memory/config.json 的 vaultDir，否则 state/memory-vault）
  --state <dir>    state 目录（默认 <root>/state）
  --message <msg>  提交信息（默认 auto: memory vault snapshot <UTC 时间>）
  --json           以 JSON 输出
  --quiet, -q      安静模式
  --help, -h       显示帮助
`;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--vault': flags.vault = argv[++i]; break;
      case '--state': flags.state = argv[++i]; break;
      case '--message': flags.message = argv[++i]; break;
      case '--json': flags.json = true; break;
      case '--quiet': case '-q': flags.quiet = true; break;
      case '--help': case '-h': flags.help = true; break;
      default:
        throw new Error(arg.startsWith('--') ? `未知选项：${arg}` : `多余参数：${arg}`);
    }
  }
  return flags;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.error) throw new Error(`git ${args[0]} 失败：${result.error.message}`);
  if (result.status !== 0 && !(Array.isArray(args) && args.includes('--quiet') && result.status === 1)) {
    const detail = (String(result.stderr || '').trim() || String(result.stdout || '').trim()).split(/\r?\n/).slice(0, 3).join(' | ');
    throw new Error(`git ${args.join(' ')} 退出码 ${result.status}${detail ? `：${detail}` : ''}`);
  }
  return result;
}

function resolveVaultDir(stateDir, explicit) {
  if (explicit) return path.resolve(explicit);
  const configPath = path.join(stateDir, 'memory', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    if (config && typeof config.vaultDir === 'string' && config.vaultDir.trim()) {
      return path.resolve(stateDir, config.vaultDir.trim());
    }
  } catch {
    // 没有 config 时走默认。
  }
  return path.join(stateDir, 'memory-vault');
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const stateDir = path.resolve(flags.state ?? path.join(REPO_ROOT, 'state'));
  const vaultDir = resolveVaultDir(stateDir, flags.vault);
  const out = (text) => {
    if (!flags.quiet && !flags.json) process.stdout.write(`${text}\n`);
  };

  if (!fs.existsSync(vaultDir) || !fs.statSync(vaultDir).isDirectory()) {
    const payload = { ok: true, skipped: true, reason: 'vault-missing', vaultDir };
    if (flags.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
    else out(`[vault-git] 跳过：vault 目录不存在（${vaultDir}）`);
    return 0;
  }

  const probe = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error || probe.status !== 0) {
    const payload = { ok: true, skipped: true, reason: 'git-unavailable', vaultDir };
    if (flags.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
    else out('[vault-git] 跳过：本机没有可用的 git');
    return 0;
  }

  const gitDir = path.join(vaultDir, '.git');
  const initialized = !fs.existsSync(gitDir);
  if (initialized) git(vaultDir, ['init', '--quiet']);

  git(vaultDir, ['add', '-A']);
  const staged = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: vaultDir, encoding: 'utf8', windowsHide: true });
  const hasChanges = staged.status === 1; // 1 = 有差异
  let commit = null;
  if (hasChanges) {
    const message = flags.message && flags.message !== true
      ? String(flags.message)
      : `auto: memory vault snapshot ${new Date().toISOString()}`;
    git(vaultDir, [
      '-c', 'user.name=qq-bridge-memory',
      '-c', 'user.email=memory@local',
      'commit', '--quiet', '-m', message,
    ]);
    const head = git(vaultDir, ['rev-parse', '--short', 'HEAD']);
    commit = String(head.stdout || '').trim() || null;
  }

  const payload = {
    ok: true,
    vaultDir,
    initialized,
    committed: Boolean(commit),
    commit,
    at: new Date().toISOString(),
  };
  if (flags.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else out(`[vault-git] ${commit ? `已提交 ${commit}` : '没有改动，无需提交'}（${vaultDir}）`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`[vault-git] ${error?.message ?? error}\n`);
  process.exitCode = 1;
}
