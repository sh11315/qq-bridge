#!/usr/bin/env node
/**
 * 记忆大脑 vault 刷新 CLI。
 *
 * 契约：docs/guides/MEMORY_SYSTEM.md §4（配置）/ §8（vault 结构）/ §11（验收）。
 * 默认读取 <repo>/state/memory/brain.json，写到 <repo>/state/memory-vault（config.vaultDir，相对 state/）。
 *
 * 用法：
 *   node scripts/memory-vault-refresh.mjs
 *   node scripts/memory-vault-refresh.mjs --brain path/to/brain.json --vault path/to/vault
 *   node scripts/memory-vault-refresh.mjs --json
 *   node scripts/memory-vault-refresh.mjs --now 2026-10-27T12:00:00Z
 *
 * 退出码：0 = 成功或还没产生记忆（跳过）；1 = brain/config/vault 读写或渲染失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderVault, VAULT_VERSION, AUTO_GEN_NOTICE } from '../src/memory/vault.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_STATE_DIR = path.join(REPO_ROOT, 'state');
const DEFAULT_VAULT_DIR = 'memory-vault';

const USAGE = `记忆大脑 vault 刷新工具（vault v${VAULT_VERSION}）

用法：
  node scripts/memory-vault-refresh.mjs [选项]

选项：
  --brain <path>    brain.json 路径（默认 <repo>/state/memory/brain.json）
  --vault <path>    vault 输出目录（默认 config.vaultDir，相对 state/ 解析）
  --state <dir>     state 目录（默认 <repo>/state）
  --now <time>      渲染用「当前时间」：毫秒时间戳或 ISO 时间串（默认 Date.now()，测试/回放用）
  --json            只输出 JSON 统计（给每日维护脚本消费）
  --quiet, -q       不打印说明文字，只打印错误
  --help, -h        显示本帮助
  --version, -v     显示 vault 版本

说明：
  - 自动生成 ${AUTO_GEN_NOTICE}
  - 只重建 vault 里 记忆/ 与 实体/ 下的笔记；vault 根目录的其他文件不会被删除。
`;

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function readOptionValue(argv, index, flag, inlineValue) {
  if (inlineValue !== null) return { value: inlineValue, nextIndex: index };
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new Error(`${flag} 需要一个值`);
  }
  return { value: next, nextIndex: index + 1 };
}

function parseArgs(argv) {
  const options = {
    brainPath: null,
    vaultPath: null,
    stateDir: null,
    now: null,
    json: false,
    quiet: false,
    help: false,
    version: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '').trim();
    if (!arg) continue;
    const equalsIndex = arg.indexOf('=');
    const flag = equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg;
    const inlineValue = equalsIndex > 0 ? arg.slice(equalsIndex + 1) : null;
    switch (flag) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--version':
      case '-v':
        options.version = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--quiet':
      case '-q':
        options.quiet = true;
        break;
      case '--brain': {
        const { value, nextIndex } = readOptionValue(argv, index, flag, inlineValue);
        options.brainPath = value;
        index = nextIndex;
        break;
      }
      case '--vault': {
        const { value, nextIndex } = readOptionValue(argv, index, flag, inlineValue);
        options.vaultPath = value;
        index = nextIndex;
        break;
      }
      case '--state': {
        const { value, nextIndex } = readOptionValue(argv, index, flag, inlineValue);
        options.stateDir = value;
        index = nextIndex;
        break;
      }
      case '--now': {
        const { value, nextIndex } = readOptionValue(argv, index, flag, inlineValue);
        options.now = value;
        index = nextIndex;
        break;
      }
      default:
        throw new Error(`未知参数：${arg}（--help 查看用法）`);
    }
  }
  return options;
}

function parseNow(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) {
    const ms = Number(text);
    if (!Number.isFinite(ms) || ms <= 0) throw new Error(`--now 不是合法毫秒时间戳：${raw}`);
    return ms;
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error(`--now 不是合法时间：${raw}`);
  return parsed;
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

function readJsonFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 读 state/memory/config.json（不存在/损坏都返回 {}）。与 store 一致：config.json 覆盖 brain.config。 */
function readMemoryConfig(memoryDir) {
  const configPath = path.join(memoryDir, 'config.json');
  if (!fs.existsSync(configPath)) return {};
  const parsed = readJsonFile(configPath);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') return {};
  return parsed.value;
}

function resolveVaultDir({ requestedVault, brain, brainPath, stateDir }) {
  let configured = requestedVault;
  if (!configured && brain?.config && typeof brain.config === 'object') {
    configured = brain.config.vaultDir;
  }
  const vaultDir = typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_VAULT_DIR;
  if (path.isAbsolute(vaultDir)) return path.resolve(vaultDir);
  // config.vaultDir 相对 state/ 解析；--brain 指向自定义位置时用其所在 state 目录。
  const baseDir = stateDir ?? path.dirname(path.dirname(brainPath));
  return path.resolve(baseDir, vaultDir);
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function formatStatsLine(stats) {
  const layers = stats.vaultLayers;
  return `记忆 ${stats.total} 条（永久 ${layers.permanent} · 长期 ${layers.long} · 短期 ${layers.short} · 边缘 ${layers.edge}）· 实体 ${stats.entities} 个 · 关系 ${stats.relations} 条`;
}

function printHumanResult(result, brainPath, vaultDir) {
  const stats = result.stats;
  console.log(`[memory-vault] 已刷新记忆大脑 vault → ${vaultDir}`);
  console.log(`  ${formatStatsLine(stats)}`);
  console.log(
    `  Canvas ${stats.canvas.nodes} 节点 / ${stats.canvas.edges} 连线 · SVG ${Math.round(
      stats.svg.bytes / 1024,
    )} KB · 文件 ${stats.filesWritten} 个（清理旧文件 ${stats.cleaned} 个）`,
  );
  console.log(`  来源：${brainPath}`);
  if (stats.canvas.hiddenMemories > 0 || stats.canvas.hiddenEntities > 0) {
    console.log(
      `  提示：Canvas/SVG 是示意图，超过显示上限的 ${stats.canvas.hiddenMemories} 条记忆 / ${stats.canvas.hiddenEntities} 个实体只在 Markdown 笔记里列全。`,
    );
  }
  console.log('  打开方式：Obsidian →「打开文件夹作为 vault」→ 选择上面的目录，然后打开 00-记忆大脑.md');
}

function printJsonResult(result, brainPath, vaultDir) {
  const payload = {
    ok: true,
    version: VAULT_VERSION,
    brainPath,
    vaultDir,
    generatedAt: result.stats.generatedAt,
    files: result.files,
    stats: result.stats,
  };
  console.log(JSON.stringify(payload, null, 2));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.version) {
    console.log(`vault v${VAULT_VERSION}`);
    return 0;
  }

  const stateDir = path.resolve(options.stateDir ?? DEFAULT_STATE_DIR);
  const brainPath = options.brainPath
    ? path.resolve(options.brainPath)
    : path.join(stateDir, 'memory', 'brain.json');
  const effectiveStateDir = options.stateDir ? stateDir : path.dirname(path.dirname(brainPath));

  let brain = null;
  if (!fs.existsSync(brainPath)) {
    const hint = `还没有 ${brainPath}：记忆系统还没产生记忆，跳过刷新。`;
    if (options.json) {
      console.log(JSON.stringify({ ok: true, skipped: true, reason: 'brain.json 不存在', brainPath, version: VAULT_VERSION }, null, 2));
    } else if (!options.quiet) {
      console.log(`[memory-vault] ${hint}`);
      console.log('  等 bot 产生记忆后再执行这个命令即可；也可以先跑 node scripts/memory-bootstrap.mjs 看示例数据。');
    }
    return 0;
  }

  const parsedBrain = readJsonFile(brainPath);
  if (!parsedBrain.ok) {
    throw new Error(`brain.json 解析失败（${brainPath}）：${parsedBrain.error?.message ?? parsedBrain.error}`);
  }
  if (!parsedBrain.value || typeof parsedBrain.value !== 'object' || Array.isArray(parsedBrain.value)) {
    throw new Error(`brain.json 顶层必须是对象（${brainPath}）`);
  }
  brain = parsedBrain.value;

  // 与 store 一致：state/memory/config.json 覆盖 brain.config（vaultDir / protectionLine / decayDays 等）。
  const fileConfig = readMemoryConfig(path.dirname(brainPath));
  if (Object.keys(fileConfig).length > 0) {
    brain = {
      ...brain,
      config: {
        ...(brain.config && typeof brain.config === 'object' ? brain.config : {}),
        ...fileConfig,
      },
    };
  }

  const vaultDir = resolveVaultDir({
    requestedVault: options.vaultPath,
    brain,
    brainPath,
    stateDir: effectiveStateDir,
  });
  const now = parseNow(options.now) ?? Date.now();

  const result = renderVault(brain, { vaultDir, now });

  if (options.json) {
    printJsonResult(result, brainPath, vaultDir);
  } else if (!options.quiet) {
    printHumanResult(result, brainPath, vaultDir);
  }
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`[memory-vault] 刷新失败：${error?.message ?? error}`);
  if (process.env.DEBUG_MEMORY_VAULT) console.error(error?.stack ?? '');
  process.exitCode = 1;
}
