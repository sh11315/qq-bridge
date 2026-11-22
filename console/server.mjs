/**
 * QQ Bridge 统一控制台（默认 7788）—— 零依赖 Node 后端。
 *
 *   node console/server.mjs                 默认端口 7788
 *   node console/server.mjs --port 7789     自测实例（不影响正在运行的 7788）
 *   node console/server.mjs -p 0            随机端口
 *
 * 它管理的是整套系统：
 *   · 进程：NapCat（3001/3000/6099）/ 桥接（3100）/ DSH Web（3080）/ 控制台自身（7788）
 *   · 模型：config.json 的 dsh.provider/model/reasoningEffort + DSH agent-default-model
 *   · 允许的人、owner、deny（config.json）
 *   · 人格：roles/*.md 与当前启用角色（启用 / 静默 / 增删改查）
 *   · 直连 api 后端（config.api）：字段配置 / 连接测试 / 模型列表 / 用量
 *   · 会话：state/sessions.json + 桥接 3100 的 /api/sessions、/api/socialV2/*
 *   · token / 花费：桥接 /api/tokens/*，桥接离线时回退解析 state/token-usage.jsonl
 *   · 诊断：端口 / bridge.lock / config 校验 / 备份恢复 / 打开目录
 *   · NapCat：登录状态、账号、WebUI、扫码二维码（走 NapCat WebUI API）
 *   · 日志：控制台内存日志 + tail state/*.log + 子进程输出，SSE 实时推送
 *
 * 设计约束（沿用原版）：
 *   · 只监听 127.0.0.1；写接口要求 Content-Type: application/json
 *   · 绝不把真实 API Key / token 返回给前端（一律掩码）；日志里也只出现掩码
 *   · 写 config.json 一律「读-改-写 + 原子替换」，解析失败拒绝写（fail-fast）
 *   · 零新依赖：只用 Node 内置模块 + 本仓库已有的 dsh-client.js / api-chat.js
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';
import { validateConfig } from '../src/config-schema.js';
import { redactLogText } from '../src/log-redact.js';
import {
  API_DEFAULTS,
  ApiChatClient,
  DEFAULT_SYSTEM_PROMPT,
  maskKey,
  normalizeApiConfig,
} from '../src/api-chat.js';
import {
  AUTOHEAL_COOLDOWN_MS,
  AUTOHEAL_INTERVAL_MS,
  AUTOHEAL_SERVICES,
  autoHealEnabled,
  decideHeal,
} from './autoheal.mjs';
// 记忆大脑：直接复用仓库里的记忆引擎（server.mjs 与 MCP / CLI 共享同一个 brain.json）。
import { MemoryService } from '../src/memory/service.mjs';
import { MemoryStore } from '../src/memory/store.mjs';
import { memoryTier, publicEntity, publicMemory, relationGroupOf, relationLabelOf, textSimilarity } from '../src/memory/model.mjs';
import { summarizeSamples, formatLifeHint } from '../src/core/life-log.mjs';
import { CONSOLE_CSP, isAllowedLoopbackHost, sessionCookie, tokensMatch, tokenFromRequest } from '../src/console-auth.js';

const CONSOLE_VERSION = '2.0.0';
const STARTED_AT = Date.now();
// 控制台页面统一安全头：CSP 挡外部脚本/点击劫持，nosniff 挡 MIME 嗅探。
const CONSOLE_SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CONSOLE_CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
});
// 是否以管理员权限运行（Windows 高完整性级别 S-1-16-12288；非 Windows 用 uid）。
const IS_ELEVATED = (() => {
  try {
    if (process.platform !== 'win32') return typeof process.getuid === 'function' ? process.getuid() === 0 : false;
    // 双重探测，避免 PATH / 本地化输出差异：
    // 1) net session 成功 = 有管理员令牌；2) whoami /groups 里出现高完整性 SID。
    const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    try {
      execFileSync(path.join(sys32, 'net.exe'), ['session'], { stdio: 'ignore', windowsHide: true });
      return true;
    } catch { /* 继续用 whoami 判断 */ }
    const out = execFileSync(path.join(sys32, 'whoami.exe'), ['/groups'], { encoding: 'utf8', windowsHide: true });
    return out.includes('S-1-16-12288');
  } catch { return false; }
})();

// ---------------------------------------------------------------- 路径 / 启动参数

const CONSOLE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(CONSOLE_DIR);
const CONFIG_PATH = path.join(ROOT, 'config.json');
const CONFIG_EXAMPLE_PATH = path.join(ROOT, 'config.example.json');
const STATE_DIR = path.join(ROOT, 'state');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const TOOL_LOG = path.join(STATE_DIR, 'tool-restrict.log');
const TOKEN_LEDGER_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const NAPCAT_EVENT_FILE = path.join(STATE_DIR, 'napcat-offline.json');
const WB_TEST_FILE = path.join(STATE_DIR, 'workbuddy-model-test.json');
const TOOL_CALLS_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
// 控制台托管的子进程日志：bridge/DSH 不再走管道（管道随控制台进程一起断），
// 改成子进程直接写文件，控制台 tail 文件补回实时日志，重启控制台也不带走服务。
const DSH_CHILD_LOG = path.join(STATE_DIR, 'dsh-child.log');
const BRIDGE_CHILD_LOG = path.join(STATE_DIR, 'bridge-child.log');
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const MODE_FILE = path.join(STATE_DIR, 'mode.json');
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');
const CONSOLE_TOKEN_FILE = path.join(STATE_DIR, 'console-token');
const SETTINGS_FILE = path.join(STATE_DIR, 'console-settings.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const ROLES_DIR = path.join(ROOT, 'roles');
const BRIDGE_ENTRY = path.join(ROOT, 'src', 'bridge.js');
const UI_PATH = path.join(CONSOLE_DIR, 'ui.html');

// 记忆仿真：读取 state/memory/sim-report-*.json；重跑用子进程，避免阻塞控制台。
const SIM_DIR = path.join(STATE_DIR, 'memory');
const DEFAULT_CAP_LONG = 20000;
const DEFAULT_CAP_SHORT = 5000;
const SIM_SCRIPT = path.join(ROOT, 'scripts', 'memory-sim.mjs');
let simRunState = { running: false, startedAt: 0, params: null, pid: 0, finishedAt: 0, exitCode: null };

function readSimLogTail(maxBytes = 6000) {
  try {
    const file = path.join(SIM_DIR, 'sim-run.log');
    if (!fs.existsSync(file)) return '';
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    return buf.toString('utf8');
  } catch { return ''; }
}

function readSimReports() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(SIM_DIR).filter((n) => /^sim-report-.*\.json$/.test(n)); } catch { return out; }
  for (const name of names) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(SIM_DIR, name), 'utf8'));
      const rep = raw && raw.report ? raw.report : raw;
      if (!rep || typeof rep !== 'object') continue;
      out.push({ name, ...rep });
    } catch { /* 跳过坏文件 */ }
  }
  const rank = (r) => {
    const n = String(r.name || '');
    if (n === 'sim-report-200k.json') return 0; // 默认展示分层配额那份
    if (/200k/.test(n) && !/nocap|v15/.test(n)) return 1;
    if (/nocap/.test(n)) return 2;
    return 3;
  };
  out.sort((a, b) => (rank(a) - rank(b)) || String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
  return out.slice(0, 10);
}

const BACKUPS_DIR = path.join(ROOT, 'backups');

// 换机/交付兜底：优先环境变量，其次系统派生路径，最后才是本机历史默认值。
// 真实取值仍以 config.json 的 unifiedConsole.{dshExe,napcatDir} 为准（本机已配）。
const DSH_INSTALL = (() => {
  const env = String(process.env.QQB_DSH_INSTALL || '').trim();
  if (env) return env;
  const local = String(process.env.LOCALAPPDATA || '').trim();
  if (local) return path.join(local, 'Programs', 'DeepSeek Harness');
  return 'C:\\Users\\1\\AppData\\Local\\Programs\\DeepSeek Harness';
})();
const DEFAULT_NAPCAT_DIR = (() => {
  const env = String(process.env.QQB_NAPCAT_DIR || '').trim();
  if (env) return env;
  // 仓库自带的 docker 模式是最常见的换机形态；没有才回落到旧的本机 shell 目录。
  const repoDocker = path.join(ROOT, 'napcat', 'docker');
  if (fs.existsSync(path.join(repoDocker, 'compose.yaml'))) return repoDocker;
  return 'C:\\Users\\1\\WorkBuddy AI\\2026-10-24-00-22-18\\napcat\\shell';
})();
const REASONING_EFFORTS = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const CONSOLE_MODES = ['chat', 'mention-only', 'reserved', 'reserved2', 'closed-agent'];

function parseArgv(argv) {
  const out = { port: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--no-open') out.noOpen = true;
  }
  return out;
}

const ARGV = parseArgv(process.argv.slice(2));
const PORT_OVERRIDE = Number.isFinite(ARGV.port) && ARGV.port >= 0
  ? Math.trunc(ARGV.port)
  : (Number(process.env.QQB_CONSOLE_PORT) > 0 ? Math.trunc(Number(process.env.QQB_CONSOLE_PORT)) : 0);

if (ARGV.help) {
  console.log(`QQ Bridge 统一控制台 v${CONSOLE_VERSION}

用法：node console/server.mjs [选项]
  --port, -p <端口>   指定监听端口（默认读 config.json unifiedConsole.port，否则 7788）
  --help, -h          显示本帮助
  --no-open           保留参数（不会自动打开浏览器）

环境变量：
  QQB_CONSOLE_PORT    同 --port
  QQB_BRIDGE_PORT     覆盖桥接端口（默认 config.json consolePort / 3100）
  QQB_DSH_BASE        覆盖 DSH baseUrl（默认 config.json dsh.baseUrl / http://127.0.0.1:3080）
`);
  process.exit(0);
}

// ---------------------------------------------------------------- 配置读写

function readConfigStrict() {
  // config.json 可能是 Windows 记事本存出来的带 BOM 文件，先剥 BOM 再解析
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('config.json 顶层必须是对象');
  return obj;
}

function readConfigSafe() {
  try { return { ok: true, cfg: readConfigStrict(), error: '' }; }
  catch (err) { return { ok: false, cfg: {}, error: err.message }; }
}

/** fail-fast 的读-改-写：解析失败绝不回写，避免把用户配置清空。 */
function updateConfigFile(mutate) {
  const file = readConfigStrict();
  const next = mutate(file) ?? file;
  const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 4), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
  return next;
}

function runtimePaths() {
  const { cfg } = readConfigSafe();
  const unified = cfg.unifiedConsole ?? {};
  const dshBase = String(process.env.QQB_DSH_BASE || cfg.dsh?.baseUrl || 'http://127.0.0.1:3080');
  let dshPort = 3080;
  try { dshPort = Number(new URL(dshBase).port || 80); } catch { /* 用默认 */ }
  return {
    cfg,
    unified,
    port: PORT_OVERRIDE || Number(unified.port || 7788),
    // 环境变量覆盖只用于自测（把控制台指向一个不存在的桥接端口，验证离线分支）
    bridgePort: Number(process.env.QQB_BRIDGE_PORT || cfg.consolePort || 3100),
    dshBase,
    dshPort,
    napcatDir: String(unified.napcatDir || DEFAULT_NAPCAT_DIR),
    napcatQQ: String(unified.napcatQQ || '100000002'),
    // Framework 模式注入的 QQ.exe 路径（留空则按注册表 Uninstall\QQ 推导，再兜底 D:\QQ.exe）
    napcatQQPath: String(unified.napcatQQPath || ''),
    napcatWsPort: Number(unified.napcatWsPort || 3001),
    napcatHttpPort: Number(unified.napcatHttpPort || 3000),
    napcatWebuiPort: Number(unified.napcatWebuiPort || 6099),
    // WorkBuddy LAN 网关：把本机已登录的 WorkBuddy 模型转成 OpenAI 兼容 API。
    // 它和 QQ 机器人是两条独立的链路，只是由同一个控制台统一托管启停/探活。
    workbuddyPort: Number(unified.workbuddyPort || 8321),
    workbuddyDir: String(unified.workbuddyDir || ''),
    workbuddyAutoStart: unified.workbuddyAutoStart !== false,
    workbuddyDataDir: String(
      unified.workbuddyDataDir
      || path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'WorkBuddyLAN'),
    ),
    dshExe: String(unified.dshExe || path.join(DSH_INSTALL, 'DeepSeek Harness.exe')),
    dshCli: String(
      unified.dshCli
      || path.join(DSH_INSTALL, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    ),
  };
}

let paths = runtimePaths();

// ── NapCat 内存看门狗 ────────────────────────────────────────────────────────
// Framework 模式下 QQ/NapCat 跑久了会膨胀（实测 30~50 分钟涨到 3.8GB），
// 然后把 6099 WebUI / 3000-3001 OneBot 全部卡死、QQ 掉线。
// 这里每轮自愈检查一次：内存超阈值、或 WebUI 连续两轮无响应 → 自动清理残留 QQ 并重新注入。
const NAPCAT_MEM_LIMIT_BYTES = 1.5 * 1024 ** 3;
const NAPCAT_MEM_RESTART_COOLDOWN_MS = 10 * 60 * 1000;
let napcatMemRestartAt = 0;
let napcatWebuiFails = 0;
/** 账号被踢下线（KickedOffLine）记录：用于区分「被踢」与「真卡死」，并避免反复无效重启。 */
let napcatKickInfo = { at: 0, count: 0, text: '' };
// NapCat 自己反复报"账号状态变更为离线"时，login phase 可能仍显示已登录 → 等不到 SelfOffline 判定。
// 这里单独记数：5 分钟内 >=2 次就当作掉登录处理，让看门狗快速重启。
let napcatOfflineNotice = { at: 0, count: 0 };

// ── 掉线历史（持久化，供 NapCat 页面展示）──
let napcatEvents = [];
let napcatOnlineState = { online: null, offlineSince: 0, lastPhase: '' };
function loadNapcatEvents() {
  try {
    const j = JSON.parse(fs.readFileSync(NAPCAT_EVENT_FILE, 'utf8'));
    napcatEvents = Array.isArray(j?.events) ? j.events.slice(-100) : [];
  } catch { napcatEvents = []; }
  // 重启控制台后不能把 online 重置成 null：否则第一次探活会把「本来就在线」当成刚上线，
  // 于是历史里每重启一次就多一条假的「上线」（曾出现连续两条「恢复/上线」）。
  // 用最后一条事件的状态续上：最后是 online 就视为在线，否则视为仍离线（并沿用离线起始时间）。
  const last = napcatEvents[napcatEvents.length - 1];
  const lastDown = Boolean(last) && last.kind !== 'online';
  napcatOnlineState = {
    online: last ? !lastDown : null,
    offlineSince: lastDown ? Number(last.at) || 0 : 0,
    lastPhase: '',
  };
}
function saveNapcatEvents() {
  try { fs.writeFileSync(NAPCAT_EVENT_FILE, JSON.stringify({ events: napcatEvents.slice(-100) }, null, 2), 'utf8'); } catch { /* 忽略 */ }
}
function recordNapcatEvent(kind, detail) {
  const now = Date.now();
  const text = String(detail ?? '').slice(0, 240);
  const last = napcatEvents[napcatEvents.length - 1];
  // 同一次故障常被连写多条（旧版控制台/桥接重试各记一次，间隔几秒）：
  // 30 秒内同类型只保留一条，原因取信息更全的那条，避免一场掉线刷出 3 行、把「今日异常」翻倍。
  if (last && last.kind === String(kind) && now - Number(last.at || 0) <= 30_000) {
    last.at = now;
    if (text.length >= String(last.detail || '').length) last.detail = text;
    saveNapcatEvents();
    return;
  }
  napcatEvents.push({ at: now, kind: String(kind), detail: text });
  while (napcatEvents.length > 100) napcatEvents.shift();
  saveNapcatEvents();
}
/** 根据最新登录状态记录上下线切换（只在状态变化时写一条）。 */
function trackNapcatOnline(info) {
  const online = Boolean(info?.online);
  const phase = String(info?.loginPhase || '');
  if (napcatOnlineState.online === online) return;
  const now = Date.now();
  if (online === false) {
    napcatOnlineState.offlineSince = now;
    const detail = info?.kicked ? `被踢：${info?.kickText || ''}` : `${phase || '未知阶段'} ${info?.error || ''}`.trim();
    recordNapcatEvent('offline', detail);
  } else {
    const downMs = napcatOnlineState.offlineSince ? now - napcatOnlineState.offlineSince : 0;
    recordNapcatEvent('online', downMs ? `恢复在线（离线 ${Math.round(downMs / 1000)} 秒）` : '上线');
    napcatOnlineState.offlineSince = 0;
  }
  napcatOnlineState.online = online;
  napcatOnlineState.lastPhase = phase;
}
loadNapcatEvents();

/** 掉线历史摘要：今日掉线次数 / 累计离线时长 / 最近一次原因。 */
function napcatHistorySummary() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const today = napcatEvents.filter((e) => e.at >= dayStart.getTime());
  const abnormal = today.filter((e) => e.kind === 'offline' || e.kind === 'kick' || e.kind === 'restart');
  // 「今日异常」按故障场次算：连续多条非 online 事件（同一场掉线被重复记录）合并成 1 次，
  // 否则掉线一次可能出现 kick + offline 两三条，数字会翻倍。
  let todayCount = 0;
  let prevDown = false;
  for (const e of today) {
    const down = e.kind !== 'online';
    if (down && !prevDown) todayCount += 1;
    prevDown = down;
  }
  let downMs = 0;
  let since = 0;
  for (const e of napcatEvents) {
    if (e.kind === 'offline' || e.kind === 'kick' || e.kind === 'restart') { if (!since) since = e.at; }
    else if (e.kind === 'online' && since) { downMs += e.at - since; since = 0; }
  }
  if (since) downMs += Date.now() - since;
  const last = napcatEvents.slice().reverse().find((e) => e.kind !== 'online');
  return { todayCount, todayEvents: abnormal.length, todayDowntimeMs: downMs, lastReason: last ? last.detail : '', lastAt: last ? last.at : 0 };
}

// ---------------------------------------------------------------- 小工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function text(res, code, body, headers = {}) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function toIdList(value) {
  if (value === undefined) return undefined;
  const arr = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
  return [...new Set(arr.map((v) => Number(String(v).trim())).filter((n) => Number.isSafeInteger(n) && n > 0))];
}

function ids(value) {
  return (Array.isArray(value) ? value : []).map((v) => Number(v)).filter((n) => Number.isSafeInteger(n) && n > 0);
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
}

function fileStat(file) {
  try {
    const st = fs.statSync(file);
    return { exists: true, size: st.size, sizeText: fmtBytes(st.size), mtime: st.mtimeMs, isFile: st.isFile() };
  } catch { return { exists: false, size: 0, sizeText: '-', mtime: 0, isFile: false }; }
}

function stampName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------- 记忆大脑
// 惰性单例：只有真正访问记忆接口时才加载 brain.json（控制台启动不因记忆库损坏而失败）。
let memoryServiceCache = null;
function getMemory() {
  if (!memoryServiceCache) {
    const store = new MemoryStore({ repoRoot: ROOT, stateDir: STATE_DIR });
    memoryServiceCache = new MemoryService({ repoRoot: ROOT, store, stateDir: STATE_DIR });
  }
  return memoryServiceCache;
}

function realVaultDir() {
  // vaultDir 可能是 junction / 符号链接（本机 state/memory-vault → Documents\记忆大脑），
  // Obsidian 注册的仓库名取自真实目录名，所以按真实路径拼 URI 最稳。
  try {
    return fs.realpathSync(getMemory().vaultDir());
  } catch {
    return getMemory().vaultDir();
  }
}

function obsidianUri(file = '') {
  const target = file ? path.join(realVaultDir(), String(file)) : realVaultDir();
  return `obsidian://open?path=${encodeURIComponent(target)}`;
}

function memoryError(res, err) {
  const known = Boolean(err && err.code);
  return json(res, known ? 400 : 500, {
    ok: false,
    code: (err && err.code) || 'MEMORY_ERROR',
    message: (err && err.message) || String(err),
  });
}

/**
 * 调记忆服务的新方法（情绪 / 自升级提案 / 一个月测试台）。
 * 后端版本还没跟上时给出可读错误，而不是 TypeError 500——控制台可以先上线、重启后自动生效。
 */
function callMemory(name, ...args) {
  const svc = getMemory();
  const fn = svc[name];
  if (typeof fn !== 'function') {
    const err = new Error(`记忆服务还没有 ${name}()，需要重启控制台以加载新版 src/memory/service.mjs`);
    err.code = 'MEMORY_NOT_READY';
    throw err;
  }
  return fn.apply(svc, args);
}

/** 一个月测试台还没后端方法时，由控制台自己写台账（只碰 state/memory/trial.json，不碰记忆库）。 */
function initMemoryTrial(raw = {}) {
  const dir = path.join(STATE_DIR, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const days = Math.min(180, Math.max(1, Number(raw.durationDays) || 30));
  const now = Date.now();
  const trial = {
    startedAt: now,
    durationDays: days,
    probe: { text: '你在开封', baselineMemoryId: null },
    createdAt: new Date(now).toISOString(),
  };
  const file = path.join(dir, 'trial.json');
  fs.writeFileSync(file, JSON.stringify(trial, null, 2) + '\n', 'utf8');
  return { ok: true, trial, file: path.relative(ROOT, file) };
}

// ---------------------------------------------------------------- 日志

const MAX_LOGS = 6000;
const logs = [];
let logSeq = 0;
const sseClients = new Set();
const lastServiceError = {};

// 日志落盘：内存环形缓冲在控制台重启后会清空，事后导出的日志常常只剩重启后的几秒。
// 这里把每条日志追加到 state/console.log，启动时回读最近一段，导出/取证才有历史可查。
const CONSOLE_LOG_FILE = path.join(ROOT, 'state', 'console.log');
const CONSOLE_LOG_MAX_BYTES = Number(process.env.QQB_CONSOLE_LOG_MAX_BYTES) || 8 * 1024 * 1024;
const CONSOLE_LOG_KEEP_BYTES = Number(process.env.QQB_CONSOLE_LOG_KEEP_BYTES) || 2 * 1024 * 1024;
const CONSOLE_LOG_RESTORE_LINES = Number(process.env.QQB_CONSOLE_LOG_RESTORE_LINES) || 2000;
let consoleLogFd = null;
let consoleLogSize = 0;
let noiseDropped = 0;

function openConsoleLogFd() {
  if (consoleLogFd !== null) return;
  try {
    fs.mkdirSync(path.dirname(CONSOLE_LOG_FILE), { recursive: true });
    try { consoleLogSize = fs.statSync(CONSOLE_LOG_FILE).size; } catch { consoleLogSize = 0; }
    consoleLogFd = fs.openSync(CONSOLE_LOG_FILE, 'a');
  } catch { consoleLogFd = null; }
}

function rotateConsoleLogIfNeeded() {
  if (consoleLogFd === null || consoleLogSize <= CONSOLE_LOG_MAX_BYTES) return;
  try { fs.closeSync(consoleLogFd); } catch { /* 忽略 */ }
  consoleLogFd = null;
  try {
    const buf = fs.readFileSync(CONSOLE_LOG_FILE);
    let keep = buf.subarray(Math.max(0, buf.length - CONSOLE_LOG_KEEP_BYTES));
    const nl = keep.indexOf(0x0a);
    if (nl >= 0) keep = keep.subarray(nl + 1);
    fs.writeFileSync(CONSOLE_LOG_FILE, keep);
    consoleLogSize = keep.length;
    consoleLogFd = fs.openSync(CONSOLE_LOG_FILE, 'a');
  } catch { /* 轮转失败就继续写，最多文件大一点 */ }
}

function appendConsoleLog(entry) {
  if (!entry || entry.restored) return;
  openConsoleLogFd();
  if (consoleLogFd === null) return;
  const line = `${new Date(entry.ts).toISOString()} [${entry.svc}] ${String(entry.level || 'info').toUpperCase()} ${entry.text}\n`;
  try {
    fs.writeSync(consoleLogFd, line);
    consoleLogSize += Buffer.byteLength(line);
    rotateConsoleLogIfNeeded();
  } catch { try { fs.closeSync(consoleLogFd); } catch { /* 忽略 */ } consoleLogFd = null; }
}

/** 启动时把上一进程的日志回读进内存（不重新落盘，避免越滚越大）。 */
function restoreConsoleLog() {
  try {
    const st = fs.statSync(CONSOLE_LOG_FILE);
    if (!st.size) return;
    const from = Math.max(0, st.size - 1024 * 1024);
    const fd = fs.openSync(CONSOLE_LOG_FILE, 'r');
    const buf = Buffer.alloc(st.size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    if (from > 0) lines.shift(); // 首行可能被截断
    const recent = lines.filter((l) => l.trim()).slice(-CONSOLE_LOG_RESTORE_LINES);
    let restoredDropped = 0;
    for (const l of recent) {
      const m = /^(\S+) \[(\w+)\] (\w+) ([\s\S]*)$/.exec(l);
      if (!m) continue;
      const ts = Date.parse(m[1]);
      if (!Number.isFinite(ts)) continue;
      // 历史文件里也可能存着过滤规则加上之前写进去的容器噪声（比如 07 点那批
      // NativeCrashHandler / PluginLoader 回放行）。恢复时一并折叠，导出才干净。
      if (m[2] === 'napcat' && isContainerNoise(m[4])) { restoredDropped += 1; continue; }
      logs.push({ seq: ++logSeq, ts, svc: m[2], level: m[3].toLowerCase(), text: m[4], restored: true });
    }
    while (logs.length > MAX_LOGS) logs.shift();
    if (restoredDropped > 0) {
      const entry = { seq: ++logSeq, ts: Date.now(), svc: 'console', level: 'debug', text: `恢复历史日志时折叠 ${restoredDropped} 条容器噪声（dbus/GPU/崩溃处理器/插件白名单回放）` };
      logs.push(entry);
      appendConsoleLog(entry);
    }
  } catch { /* 没有历史日志就算了 */ }
}

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]/g;
/** 容器日志带 ANSI 颜色时，旧实现只去掉了 ESC 字符，留下 "[32m" 这种垃圾。 */
function stripAnsiText(text) { return String(text ?? '').replace(ANSI_RE, ''); }

// 容器日志里一半是 Chromium 在无 GPU/dbus 的容器里刷的噪声；启动时 --tail 200 还会
// 把十几分钟前的开机日志当成"刚发生"回放。两类都直接折叠，导出日志才有信号。
const CONTAINER_NOISE_RE = new RegExp([
  // Chromium 在无 GPU / 无 dbus 容器里的固定噪声
  'dbus\\/|Failed to connect to the bus|org\\.freedesktop\\.DBus|gl_surface|gl_context|EGL config|gpu_init|gpu_info_collector|viz_main_impl|Exiting GPU process|Could not create surface',
  // QQ 客户端原生崩溃处理器：容器里没有可写的 dump 目录，每次挂起/探活都会刷
  // "open file error!!!"（不是真的崩溃，删了也不影响判断），以及每次重启回放的
  // 插件白名单拒绝行。
  'NativeCrashHandler|getCrashDetailBeanFromRecord|open file error!!!',
  '\\[PluginLoader\\] Rejected',
  // NapCat 自带的 OpenTelemetry 导出器：QQ 昵称/消息里带非法 UTF-8 时，序列化 span 名会刷
  // "libprotobuf ERROR ... String field 'opentelemetry.proto.trace.v1.SpanEvent.name' contains
  // invalid UTF-8 data"。纯上游 telemetry 缺陷，不影响收发消息，折叠掉。
  'libprotobuf ERROR|wire_format_lite\\.cc|invalid UTF-8 data when serializing',
].join('|'), 'i');
const CONTAINER_TS_RE = /(?:^|\[|\s)(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/;

function bumpNoiseDropped() {
  noiseDropped += 1;
  if (noiseDropped % 200 !== 0) return;
  // 直接入库，不要走 pushLog（避免自身再被过滤/记账递归）
  const entry = { seq: ++logSeq, ts: Date.now(), svc: 'console', level: 'debug', text: `容器日志噪声已折叠 ${noiseDropped} 条（dbus/GPU/启动回放）` };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  appendConsoleLog(entry);
  broadcast('log', entry);
}

function isContainerNoise(piece) {
  if (CONTAINER_NOISE_RE.test(piece)) return true;
  const m = CONTAINER_TS_RE.exec(piece);
  if (!m) return false;
  const now = new Date();
  const ts = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  // 容器日志自带时间戳：超过 15 分钟的一律视为启动回放
  return Number.isFinite(ts) && now.getTime() - ts > 15 * 60_000;
}

/** 找本机局域网 IPv4（优先 192.168/10./172.16-31，排除虚拟网卡里常见但手机连不上的网段）。 */
function lanCandidates() {
  const VIRTUAL = /vEthernet|VMware|VirtualBox|Hyper-V|Loopback|veth|WSL|Tailscale|ZeroTier/i;
  const WIFI = /WLAN|Wi-Fi|WiFi|无线/i;
  const list = [];
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of ifaces || []) {
      if (a && a.family === 'IPv4' && !a.internal) list.push({ name, ip: a.address });
    }
  }
  const ipScore = (ip) => ip.startsWith('192.168.') ? 3 : ip.startsWith('10.') ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 1 : 0;
  // 手机基本都走 WiFi：无线网卡优先，其次才是 192.168 等常见内网段
  list.sort((a, b) => (WIFI.test(b.name) ? 10 : 0) + ipScore(b.ip) - ((WIFI.test(a.name) ? 10 : 0) + ipScore(a.ip)));
  return list;
}
function lanIpv4() {
  return lanCandidates()[0]?.ip || '';
}

function classify(text) {
  // NapCat/QQ 的日志带 ANSI 颜色码（如 \x1b[33mwarn\x1b[39m / \x1b[31merror\x1b[39m）。
  // 不先剥掉的话，显式级别匹配会被颜色码挡住，再被下面的关键词兜底误判成 error（2026-10-28 修）。
  text = String(text ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  // 0) 已知良性的 QQ/Electron 底层噪音：先降级，避免「最近错误/告警」被刷红。
  //    · WSALookupServiceBegin failed 10108 / network_change_notifier_win.cc
  //      = QQ 内置 Chromium 的「网络变化通知」报错，登录/未登录都会出现，无害；
  //    · Failed to create GPU process / gpu_process_host = 显卡进程创建失败，QQ 会回退软件渲染；
  //    · DevTools listening = 只是调试端口提示。
  if (/WSALookupServiceBegin failed|network_change_notifier_win\.cc|Failed to create GPU process|gpu_process_host|DevTools listening|SnowLuma WebSocket closed before opening|SnowLuma 连接断开|SnowLuma 错误|\[NapCat\] \[Error\] unhandledRejection|消息已过期或者为内层消息|无法获取转发消息|pngsave: no property named|dbus|org\.freedesktop\.DBus/i.test(text)) return 'debug';
  // 0b) 显式级别之前先拦这些"已知良性/功能层失败"：否则 `[ERROR ]`（带空格）会被当成真错误。
  if (/消息不存在|model file exit|git lfs to clone model file/.test(text)) return 'debug';
  // 无头容器里的 Chromium/GPU 噪音（headless 无显卡，必然报，无害）
  if (/gpu_init\.cc|viz_main_impl|CollectGraphicsInfo|Exiting GPU process|GLES|vulkan|gl_context_egl|gl_surface_egl|gpu_info_collector|network_service_instance_impl|ERROR:ui\/gl|ERROR:gpu\//i.test(text)) return 'debug';
  if (/token 自愈失败|黑话提取失败|学习会话 turn 超时/.test(text)) return 'warn';
  // DSH 的 cline 模型目录走直连外网，本机常连不上；这是目录缺项提示，不是服务故障
  if (/模型目录来源缺失|模型目录来源失败|模型目录.*网络请求失败/.test(text)) return 'warn';
  // 2g) WorkBuddy 网关的 "HTTP 连接提前结束"：客户端主动断开（切模型/重启/超时取消），不是上游故障
  if (/HTTP 连接提前结束/.test(text)) return 'debug';

  // 1) 优先看显式级别标记：NapCat 的 `[info]`/`[31merror[39m]`、桥接/控制台的 `ERROR`/`WARN`/`INFO`
  const explicit = /\[(?:3[0-9]m)?(error|warn|info|debug|trace)(?:\[39m)?\]/i.exec(text)
    || /\b(ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\b/.exec(text);
  if (explicit) {
    const lv = explicit[1].toLowerCase();
    if (lv === 'trace' || lv === 'debug') return 'debug';
    if (lv === 'warn' || lv === 'warning') return 'warn';
    if (lv === 'error') return 'error';
    return 'info';
  }
  // 2) QQ 消息收发行一律 info —— 群友的聊天内容里经常带「错误」「失败」等词，
  //    不能当成服务错误（否则「最近错误/告警」会被正常聊天刷满误报）。
  if (/接收\s*<-|发送\s*->|收到\s*</.test(text)) return 'info';
  // 2b) 已知良性的诊断行：qq-tool-restrict 的 unknown 工具 no-op 会打印「失败」字样，
  //     但这是预期行为（执行期白名单仍生效），不是服务错误。
  if (/tools\.restrict\(\)|unknown global tool|延迟重试 ok=|失败样例/.test(text)) return 'info';
  // 2c) 补投结果行：即使文案里带「失败 0 条」也不是错误（2026-10-26 误报）。
  if (/已补投|补投.*成功 \d+ 条/.test(text)) return 'info';
  // 2d) 媒体投递结果（含"获取失败"）是功能层面的瞬时结果，不是服务错误
  if (/媒体投递：/.test(text)) return 'info';
  // 2e) QQ 侧"消息不存在"、黑话学习超时：都是功能层瞬时失败，不是服务故障
  if (/消息不存在/.test(text)) return 'debug';
  // 2f) QQ 客户端自带的语音转文字缺 whisper 模型文件时的报错（与机器人无关，收语音消息就会打）
  if (/model file exit|git lfs to clone model file/.test(text)) return 'debug';
  // 无头容器里的 Chromium/DBus 原始日志（形如 "[175:1026/171225.44:ERROR:dbus/...]"），全是环境噪音
  if (/^\[\d+:\d+\/\d+\.\d+:(?:ERROR|WARNING):/.test(text)) return 'debug';
  if (/dbus\/|org\.freedesktop|Failed to connect to the bus/.test(text)) return 'debug';
  if (/黑话提取失败|学习会话 turn 超时/.test(text)) return 'warn';
  // 3) 没有显式级别时才用关键词兜底
  if (/\b(exception|fatal|crash|ECONNREFUSED|EADDRINUSE)\b/i.test(text)
    || /(错误|失败|异常|崩溃|无法连接|拒绝连接)/.test(text)) return 'error';
  if (/\b(warning|deprecated)\b/i.test(text) || /(警告|超时|⚠️)/.test(text)) return 'warn';
  if (/调试/i.test(text)) return 'debug';
  return 'info';
}

// 日志脱敏（2026-11-12）：DSH 启动时会往 stdout 打印带 token 的登录 URL
// （`dsh web: http://127.0.0.1:3080/?token=...`），这个 URL 能直接登录 DSH。
// 该 stdout 被 spawnLogged 重定向进 state/dsh-child.log，控制台又 tail 它显示到
// 「实时日志」——等于把凭据写进磁盘 + 送上页面。所有日志统一在入库前脱敏。
// 约定：每条规则的**第 1 组是前缀**、**第 2 组是密钥本体**——pushLog 用 `$1***` 替换，
// scrubSecretsInFile 用第 1 组长度算偏移、只覆写第 2 组那几个字节。
const SECRET_REDACTIONS = [
  // URL 查询串里的 token：?token=xxx / &token=xxx
  [/([?&]token=)([A-Za-z0-9._~+/=-]{8,})/gi, '$1***'],
  // 显式键值：access_token= / api_key: / apiKey= / secret:
  [/(\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|secret)\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{12,})/gi, '$1***'],
  // Authorization: Bearer xxx
  [/(\bbearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi, '$1***'],
];

// 与 bridge 共用同一套日志脱敏：token / Authorization / Cookie / QQ 号 / 绝对路径。
// 已知令牌从 config 与 state/console-token 精确登记，裸串也能打码。
const CONSOLE_LOG_SECRETS = new Set();
let consoleLogSecretsReady = false;
function rememberConsoleLogSecrets() {
  const cfg = paths.cfg || {};
  const values = [
    cfg.snowluma?.accessToken,
    cfg.dsh?.authToken,
    cfg.api?.apiKey,
    cfg.imageGen?.apiKey,
    cfg.unifiedConsole?.token,
    cfg.ownerQQ,
    paths.napcatQQ,
    readConsoleToken(),
  ];
  for (const value of values) {
    if (typeof value === 'string' && value.length >= 6) CONSOLE_LOG_SECRETS.add(value);
  }
}

function redactSecrets(text) {
  if (!consoleLogSecretsReady) {
    consoleLogSecretsReady = true;
    try { rememberConsoleLogSecrets(); } catch { /* 配置未就绪时用通用规则 */ }
  }
  return redactLogText(text, CONSOLE_LOG_SECRETS);
}

// 子进程的 stdout 是「fd 直接重定向到文件」的，pushLog 的脱敏管不到落盘那一份。
// DSH 启动时会把带 token 的登录 URL 打到 stdout，于是凭据照样写进 state/dsh-child.log。
// 这里在服务启动后对文件做一次**等长原地覆写**：把 token 那段字节换成等量 '*'，
// 文件长度不变，所以不会打乱子进程已持有的追加偏移（比 read-modify-write 安全）。
const SCRUB_SCAN_BYTES = 8 * 1024 * 1024;
function scrubSecretsInFile(file, maxBytes = SCRUB_SCAN_BYTES) {
  if (!file) return 0;
  let fd = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return 0;
    const start = maxBytes === Infinity ? 0 : Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    const rfd = fs.openSync(file, 'r');
    try { fs.readSync(rfd, buf, 0, len, start); } finally { fs.closeSync(rfd); }
    // latin1 下 1 char == 1 byte，匹配下标可直接当字节偏移用
    const text = buf.toString('latin1');
    const ranges = [];
    for (const [re] of SECRET_REDACTIONS) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      let m;
      while ((m = g.exec(text)) !== null) {
        // 第 1 组是前缀，第 2 组是密钥本体：偏移 = 匹配起点 + 前缀长度
        const secret = m[2];
        if (!secret || secret === '***') continue;
        const at = m.index + m[1].length;
        ranges.push([at, at + secret.length]);
      }
    }
    if (ranges.length === 0) return 0;
    fd = fs.openSync(file, 'r+');
    for (const [s, e] of ranges) {
      const n = e - s;
      if (n <= 0) continue;
      fs.writeSync(fd, Buffer.alloc(n, 0x2a), 0, n, start + s);
    }
    return ranges.length;
  } catch { return 0; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* 忽略 */ } } }
}

restoreConsoleLog();

function pushLog(svc, rawText, level = null) {
  const line = stripAnsiText(redactSecrets(String(rawText ?? ''))).replace(/\r/g, '').replace(/\u0000/g, '');
  if (!line.trim()) return;
  // 一个 data 事件里可能带多行；逐行入库，前端才能过滤/搜索
  for (const piece of line.split('\n')) {
    if (!piece.trim()) continue;
    if (svc === 'napcat' && isContainerNoise(piece)) { bumpNoiseDropped(); continue; }
    const entry = { seq: ++logSeq, ts: Date.now(), svc, level: level || classify(piece), text: piece };
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.shift();
    if (entry.level === 'error') lastServiceError[svc] = entry;
    appendConsoleLog(entry);
    broadcast('log', entry);
  }
}

function broadcast(event, data) {
  if (sseClients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

/** 文件 tail：只读新增部分；文件变小（轮转/清空）时从头读。 */
const tailState = new Map();

function tailFile(svc, file, { strip = null, initialTailBytes = 0, dropBlock = null } = {}) {
  // 默认只跟随新增内容：回放历史会把旧日志按"现在"的时间戳塞进实时日志/告警，
  // 让人误以为故障刚发生（曾把网关两小时前的 port_in_use 当成当前错误）。
  let st = null;
  try { st = fs.statSync(file); } catch { return; }
  const prev = tailState.get(file) || { offset: 0, at: 0 };
  let offset = prev.offset;
  if (!offset || st.size < offset) {
    // 首轮（或文件变小=轮转）：从「当前末尾 - initialTailBytes」开始。
    // 注意必须立刻把基线写回 tailState —— 否则 initialTailBytes=0 时 offset 恰好等于
    // st.size，下面 `st.size === offset` 直接 return，tailState 永远不落地，
    // 于是每秒都当成「首轮」重来，这个文件的新增内容永远读不到（2026-11-12 修复：
    // 实时日志里 bridge/dsh/tool 一直是空的，只有走管道的 console/napcat 有内容）。
    offset = Math.max(0, st.size - initialTailBytes);
    tailState.set(file, { offset, at: Date.now() });
  }
  if (st.size === offset) return;
  let buf = '';
  try {
    const len = st.size - offset;
    if (len <= 0) return;
    const fd = fs.openSync(file, 'r');
    const readBuf = Buffer.alloc(len);
    fs.readSync(fd, readBuf, 0, len, offset);
    fs.closeSync(fd);
    buf = readBuf.toString('utf8');
  } catch { return; }
  tailState.set(file, { offset: st.size, at: Date.now() });
  // dropBlock：丢掉「已知且会无限重复」的多行噪声块（触发行 + 紧跟的堆栈帧）。
  // 触发行本身也只每 5 分钟提示一次，否则它自己就会把实时日志刷满
  // （DSH 的 task-board 插件因网关签名不兼容，每 5 秒抛一次，一次 10 行）。
  let inDropBlock = false;
  for (const line of buf.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const text2 = strip ? line.replace(strip, '') : line;
    if (!text2.trim()) continue;
    if (dropBlock) {
      if (dropBlock.trigger.test(text2)) {
        inDropBlock = true;
        const last = dropBlockNoticeAt.get(file) || 0;
        if (Date.now() - last > 5 * 60 * 1000) {
          dropBlockNoticeAt.set(file, Date.now());
          pushLog(svc, `${text2.slice(0, 120)}（同类堆栈已折叠，5 分钟内不再提示）`, 'warn');
        }
        continue;
      }
      if (inDropBlock && dropBlock.frame.test(text2)) continue;
      inDropBlock = false;
    }
    pushLog(svc, text2);
  }
}
const dropBlockNoticeAt = new Map();

function tailAll() {
  tailFile('bridge', BRIDGE_LOG, { strip: /^\d{1,2}:\d{2}:\d{2}\s*(\[[\w-]+\]\s*)?/ });
  tailFile('activity', ACTIVITY_LOG);
  // tool-restrict.log 只在出现新行时进日志（数量少，能帮助排查工具限制）
  tailFile('tool', TOOL_LOG);
  // DSH 的 stdout/stderr 现在直接写 state/dsh-child.log（不再走管道），tail 它保持「实时日志」里能看到 DSH 输出。
  // 其中 @linxin666/dsh-client-ui-task-board 因网关签名不兼容每 5 秒抛一次（一次 10 行堆栈），
  // 会把实时日志刷满，按已知噪声块折叠掉。
  tailFile('dsh', DSH_CHILD_LOG, {
    dropBlock: {
      trigger: /^\[dsh-task-board\] session\/list failed/,
      frame: /^\s+at .*(dsh-client-ui-task-board|dsh-api-gateway|cordis)\/lib\/index\.js/,
    },
  });
  // bridge-child.log 只存 bridge 的 stdout/stderr 崩溃现场：bridge 自己已把同样的内容写进 bridge.log，
  // 这里不再 tail，避免每条日志显示两遍。
  // WorkBuddy LAN 的网关日志（数据目录在 %LOCALAPPDATA%\WorkBuddyLAN）
  // 注意：只在新增行时展示。若第一次就回放历史（initialTailBytes>0），网关上次启动时
  // 的 "启动失败/port_in_use" 会被打上当前时间戳，看起来像刚发生的故障。
  try { tailFile('workbuddy', path.join(paths.workbuddyDataDir, 'gateway.log'), { strip: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}\s*/, initialTailBytes: 0 }); } catch { /* 路径不可用就跳过 */ }
}

function recentLogs({ since = 0, svc = 'all', level = 'all', q = '', limit = 500 } = {}) {
  const needle = String(q || '').toLowerCase();
  const out = [];
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const l = logs[i];
    if (l.seq <= since) break;
    if (svc && svc !== 'all' && l.svc !== svc) continue;
    if (level && level !== 'all' && l.level !== level) continue;
    if (needle && !l.text.toLowerCase().includes(needle)) continue;
    out.push(l);
    if (out.length >= limit) break;
  }
  return out.reverse();
}

function logCounts() {
  const counts = { all: logs.length };
  const levels = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const l of logs) {
    counts[l.svc] = (counts[l.svc] || 0) + 1;
    if (levels[l.level] !== undefined) levels[l.level] += 1;
  }
  return { byService: counts, byLevel: levels };
}

// ---------------------------------------------------------------- 进程 / 端口

let netstatCache = { at: 0, map: new Map(), text: '' };

/** 一次 netstat -ano 解析出所有 LISTENING 端口 → PID（原版每个端口跑一次，这里合并）。 */
function netstatMap() {
  if (Date.now() - netstatCache.at < 2500) return netstatCache.map;
  const map = new Map();
  let out = '';
  try { out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, encoding: 'latin1', timeout: 8000 }); } catch { /* 无 netstat */ }
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (!m) continue;
    const port = Number(m[1]);
    const pid = m[2];
    if (!map.has(port)) map.set(port, pid);
  }
  netstatCache = { at: Date.now(), map, text: out };
  return map;
}

function pidForPort(port) {
  return netstatMap().get(Number(port)) || null;
}

let procCache = { at: 0, byPid: new Map() };

/**
 * 用 PowerShell 一次拿多个 PID 的 名称/内存/CPU/启动时间/路径。
 * 拿不到 StartTime（权限不足）时 startedAt 为空，前端显示「未知」。
 */
function queryProcesses(pids) {
  const wanted = [...new Set((pids || []).map((p) => String(p || '')).filter((p) => /^\d+$/.test(p)))];
  const now = Date.now();
  if (now - procCache.at < 3000) {
    const hit = wanted.every((p) => procCache.byPid.has(p));
    if (hit) return mapResult(procCache.byPid, wanted);
  }
  if (!wanted.length) return {};
  const script = `$ids=@(${wanted.join(',')});$out=@();`
    + 'foreach($p in $ids){$pr=Get-Process -Id $p -ErrorAction SilentlyContinue;'
    + "if($pr){$st='';try{$st=$pr.StartTime.ToUniversalTime().ToString('o')}catch{};"
    + "$pa='';try{$pa=$pr.Path}catch{};"
    + '$out+=[pscustomobject]@{id=$pr.Id;name=$pr.ProcessName;mem=$pr.WorkingSet64;cpu=$pr.CPU;startedAt=$st;path=$pa}}};'
    + "if($out.Count -gt 0){$out|ConvertTo-Json -Compress}else{''}";
  let data = [];
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    }).trim();
    if (out) {
      const parsed = JSON.parse(out);
      data = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch { /* 降级：只有 PID */ }
  const byPid = new Map();
  for (const item of data) {
    if (!item || item.id === undefined) continue;
    byPid.set(String(item.id), {
      pid: Number(item.id),
      name: String(item.name || ''),
      mem: Number(item.mem) || 0,
      cpu: Number(item.cpu) || 0,
      startedAt: item.startedAt ? Date.parse(item.startedAt) : 0,
      path: String(item.path || ''),
    });
  }
  procCache = { at: now, byPid };
  return mapResult(byPid, wanted);
}

function mapResult(byPid, wanted) {
  const out = {};
  for (const p of wanted) out[p] = byPid.get(p) || { pid: Number(p), name: '', mem: 0, cpu: 0, startedAt: 0, path: '' };
  return out;
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function probe(port, timeout = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: Number(port), host: '127.0.0.1' });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function killTree(pid) {
  if (!pid) return false;
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); return true; }
  catch { return false; }
}

async function waitPort(port, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await probe(port)) return true;
    await sleep(600);
  }
  return false;
}

/** 等到端口不再被监听（进程优雅退出）。用于刚停服务后启动前，避免误报“残留进程”。 */
async function waitPortGone(port, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!(await probe(port)) && !pidForPort(port)) return true;
    await sleep(300);
  }
  return !(await probe(port)) && !pidForPort(port);
}

/**
 * 启动前的端口清理：旧实例还没退干净时（listen EADDRINUSE 的典型原因），
 * 先把监听该端口的残留进程结束并等它释放端口，再拉起新进程。
 * 只在「端口没有活服务（probe 失败）」时调用；返回 false 表示清理失败。
 */
async function clearStalePort(port, label) {
  const pid = pidForPort(port);
  if (!pid) return true;
  pushLog('console', `${label}：端口 ${port} 被残留进程 ${pid} 占用，先清理再启动`, 'warn');
  killTree(pid);
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    if (!pidForPort(port)) {
      pushLog('console', `${label}：端口 ${port} 已释放`);
      return true;
    }
  }
  pushLog('console', `${label}：端口 ${port} 清理超时（仍有进程占用，可能出现 EADDRINUSE）`, 'error');
  return false;
}

// ---------------------------------------------------------------- 子进程

const children = { napcat: null, bridge: null, dsh: null, workbuddy: null };
// 我们主动停的服务（重启/停止请求）：退出码非 0 也不该报 warn，日志写成「已停止」。
const expectedStops = new Set();

// 「正在启动中」防重入：端口还没起来之前，自愈和重复点击都不该再拉第二个实例。
// NapCat 尤其致命：两个实例抢同一个 QQ，worker 会被互相踢下线（日志里 Worker 退出码 1 循环）。
const starting = { napcat: false, dsh: false, bridge: false, workbuddy: false };

// ── WorkBuddy LAN 网关 ───────────────────────────────────────────────────────
// 它把本机已登录的 WorkBuddy 模型转成 OpenAI 兼容 API（/v1/chat/completions）。
// 控制台只负责：探活（健康检查）、启停、把 API 地址/密钥展示给用户。
function workbuddyExe() {
  if (!paths.workbuddyDir) return '';
  const exe = path.join(paths.workbuddyDir, 'WorkBuddy-LAN.exe');
  return fs.existsSync(exe) ? exe : '';
}

/** 枚举本机的 WorkBuddy-LAN.exe 进程。只认安装目录下的那个，避免误杀同名程序。 */
function workbuddyProcessIds() {
  try {
    const dir = path.resolve(paths.workbuddyDir || '');
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='WorkBuddy-LAN.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress",
    ], { windowsHide: true, encoding: 'utf8', timeout: 8000 });
    const text = out.trim();
    if (!text) return [];
    const list = JSON.parse(text);
    const rows = Array.isArray(list) ? list : [list];
    return rows
      .filter((row) => {
        const exe = path.resolve(String(row.ExecutablePath || ''));
        return dir ? exe.toLowerCase().startsWith(dir.toLowerCase()) : true;
      })
      .map((row) => Number(row.ProcessId))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch { return []; }
}

/** 探活：不只看端口，还要 /healthz 真的返回 JSON（端口在听但进程卡死时能区分出来）。 */
async function probeWorkbuddy(timeout = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${paths.workbuddyPort}/healthz`, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': `qq-bridge-console/${CONSOLE_VERSION}` },
    });
    if (!res.ok) return { up: false, version: '' };
    const data = await res.json().catch(() => ({}));
    return { up: data?.ok !== false, version: String(data?.version || '') };
  } catch {
    return { up: false, version: '' };
  }
}

// API Key 由 WorkBuddy LAN 用 Windows DPAPI 加密存在 settings.json；
// 控制台与它同一个 Windows 用户，可以用 PowerShell 解出来给用户复制。
let workbuddyKeyCache = { at: 0, key: '' };
function workbuddyApiKey() {
  if (workbuddyKeyCache.key && Date.now() - workbuddyKeyCache.at < 60_000) return workbuddyKeyCache.key;
  try {
    const file = path.join(paths.workbuddyDataDir, 'settings.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const b64 = String(raw?.key_dpapi || '');
    if (!b64) return '';
    const script = [
      'Add-Type -AssemblyName System.Security;',
      '$b=[Convert]::FromBase64String($env:WB_KEY_B64);',
      "$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);",
      '[Text.Encoding]::UTF8.GetString($k)',
    ].join(' ');
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, WB_KEY_B64: b64 },
    });
    const key = out.trim();
    if (key) workbuddyKeyCache = { at: Date.now(), key };
    return key;
  } catch { return ''; }
}

/** 模型列表（带缓存 30s）：用于在卡片上显示“可用模型数”。 */
let workbuddyModelsCache = { at: 0, count: 0, ids: [] };
async function workbuddyModels() {
  if (workbuddyModelsCache.ids.length && Date.now() - workbuddyModelsCache.at < 30_000) return workbuddyModelsCache;
  const key = workbuddyApiKey();
  if (!key) return workbuddyModelsCache;
  try {
    const res = await fetch(`http://127.0.0.1:${paths.workbuddyPort}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(6000),
    });
    const data = await res.json();
    const ids = Array.isArray(data?.data) ? data.data.map((m) => String(m.id)).filter(Boolean) : [];
    if (ids.length) workbuddyModelsCache = { at: Date.now(), count: ids.length, ids };
  } catch { /* 拉不到就沿用旧缓存 */ }
  return workbuddyModelsCache;
}

async function startWorkbuddy() {
  if ((await probeWorkbuddy()).up) { pushLog('console', 'WorkBuddy LAN 已在运行（健康检查通过）'); return true; }
  if (starting.workbuddy) { pushLog('console', 'WorkBuddy LAN 正在启动中，跳过重复拉起'); return false; }
  starting.workbuddy = true;
  try {
    const exe = workbuddyExe();
    if (!exe) {
      pushLog('console', `WorkBuddy LAN 启动失败：找不到 ${paths.workbuddyDir || '(未配置)'}\\WorkBuddy-LAN.exe；可在 config.json 的 unifiedConsole.workbuddyDir 指定目录`, 'error');
      return false;
    }
    if (await probe(paths.workbuddyPort)) {
      // 端口在听但 /healthz 不通 = 之前那个 WorkBuddy LAN 卡死了（已不再是我们管理的子进程）。
      // 只要确认是本机安装目录下的 WorkBuddy-LAN.exe，就结束它再重新拉起，避免自愈永远卡在“端口被占用”。
      const stale = workbuddyProcessIds();
      if (!stale.length) {
        pushLog('console', `WorkBuddy LAN 启动失败：端口 ${paths.workbuddyPort} 已被其他程序占用`, 'error');
        return false;
      }
      pushLog('console', `WorkBuddy LAN 端口被遗留进程（PID ${stale.join(', ')}）占用，先结束再重启`, 'warn');
      for (const pid of stale) killTree(pid);
      if (!(await waitPortGone(paths.workbuddyPort, 12_000))) {
        pushLog('console', `WorkBuddy LAN 启动失败：结束遗留进程后端口 ${paths.workbuddyPort} 仍被占用`, 'error');
        return false;
      }
    }
    spawnLogged('workbuddy', exe, ['--serve'], { cwd: path.dirname(exe) });
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if ((await probeWorkbuddy(1200)).up) { pushLog('console', `WorkBuddy LAN 已启动（:${paths.workbuddyPort} 健康检查通过）`); return true; }
      await sleep(800);
    }
    pushLog('console', 'WorkBuddy LAN 启动超时（45s 内健康检查未通过，看 WorkBuddyLAN\\gateway.log）', 'error');
    return false;
  } finally {
    starting.workbuddy = false;
  }
}

/** 列出当前存活的 NapCat 相关 node 进程（NapCat 是父进程 + worker 两层）。 */
function napcatProcessIds() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*napcat*' } | Select-Object -ExpandProperty ProcessId",
    ], { windowsHide: true, encoding: 'utf8', timeout: 8000 });
    return out.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number);
  } catch { return []; }
}

/**
 * 当前 NapCat 运行模式：
 *   docker    = NapCat 跑在 Linux 容器里（napcatDir 下有 compose.yaml），与宿主机 QQ 完全隔离，
 *               天然绕开 Windows QQ 9.9.31 在 onOpentelemetryInit 卡死的问题；
 *   framework = NapCat.Framework，注入“已安装的桌面 QQ”（napcatDir 里有 napiLoader.bat / napimain.exe）；
 *   shell     = NapCat Shell，自带 QQ 内核的 node 进程（napcatDir 里有 node.exe + index.js）。
 */
function napcatMode() {
  try {
    // 显式指定优先（config.json 的 unifiedConsole.napcatRunner = "docker"）
    if (String(paths.unified?.napcatRunner || '').toLowerCase() === 'docker') return 'docker';
    // 自动识别：有 compose.yaml 就当 Docker 模式，别的文件都不用找
    if (fs.existsSync(path.join(paths.napcatDir, 'compose.yaml'))) return 'docker';
    return fs.existsSync(path.join(paths.napcatDir, 'napiLoader.bat')) ? 'framework' : 'shell';
  } catch { return 'shell'; }
}

/** Docker Desktop 的 docker.exe；装完不一定在当前 PATH 里（控制台可能比安装早启动），按安装路径兜底。 */
function dockerExe() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const candidates = [
    path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
    'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
  ];
  for (const file of candidates) if (fs.existsSync(file)) return file;
  try {
    const out = execFileSync('where', ['docker'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  } catch { /* 没装 docker 就是没装 */ }
  return '';
}

function dockerDesktopExe() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const candidates = [
    path.join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe'),
    'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
  ];
  return candidates.find((file) => fs.existsSync(file)) || '';
}

function dockerComposePath() { return path.join(paths.napcatDir, 'compose.yaml'); }

/** Docker 模式下读取容器详情（镜像 / 状态 / 重启策略 / 端口）。失败返回 null。 */
function dockerContainerInfo() {
  if (napcatMode() !== 'docker') return null;
  const docker = dockerExe();
  if (!docker) return null;
  try {
    const out = execFileSync(docker, ['inspect', dockerContainerName(), '--format', '{{json .}}'], {
      encoding: 'utf8', timeout: 12000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const c = JSON.parse(out);
    const startedAt = c.State?.StartedAt ? Date.parse(c.State.StartedAt) : 0;
    return {
      name: String(c.Name || '').replace(/^\//, ''),
      image: String(c.Config?.Image || ''),
      running: Boolean(c.State?.Running),
      status: String(c.State?.Status || ''),
      startedAt: Number.isFinite(startedAt) ? startedAt : 0,
      restartPolicy: String(c.HostConfig?.RestartPolicy?.Name || ''),
      ports: (c.NetworkSettings?.Ports ? Object.entries(c.NetworkSettings.Ports) : [])
        .map(([internal, binds]) => ({ internal, host: (binds || []).map((b) => b.HostPort).filter(Boolean).join(',') }))
        .filter((x) => x.host),
    };
  } catch { return null; }
}

// Docker 模式下把容器日志接进控制台日志流（掉线历史/实时日志才有 NapCat 的行）。
let napcatDockerLogChild = null;
function ensureNapcatDockerLogStream() {
  if (napcatMode() !== 'docker') return;
  if (napcatDockerLogChild && !napcatDockerLogChild.killed) return;
  const docker = dockerExe();
  if (!docker) return;
  try {
    napcatDockerLogChild = spawnLogged('napcat', docker, ['logs', '-f', '--tail', '200', dockerContainerName()], { cwd: paths.napcatDir });
    if (napcatDockerLogChild) {
      napcatDockerLogChild.on('exit', () => { napcatDockerLogChild = null; });
      pushLog('console', `NapCat(Docker) 容器日志已接入控制台实时日志（容器 ${dockerContainerName()}）`, 'info');
    }
  } catch (err) {
    pushLog('console', `NapCat(Docker) 日志接入失败：${err.message}`, 'warn');
  }
}

/** 容器名与 compose.yaml 里的 container_name 保持一致；可用 config.json 的 napcatContainer 覆盖。 */
function dockerContainerName() {
  return String(paths.unified?.napcatContainer || 'napcat-qq');
}

/** Docker daemon 是否就绪（Docker Desktop 还在启动 / 要求登录 / WSL2 未更新时都会失败）。 */
function dockerReady(docker, timeoutMs = 20000) {
  if (!docker) return false;
  try {
    const out = execFileSync(docker, ['info', '--format', '{{.ServerVersion}}'], {
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Docker Desktop 在 WSL 引擎起不来时会回一句 "unable to start"，此时 CLI 可能仍退 0，
    // 但 ServerVersion 是空的——必须按空串判失败，否则会误以为引擎就绪、直接去 compose 然后报错。
    return Boolean(String(out || '').trim());
  } catch { return false; }
}

/** Docker Desktop 的引擎服务（com.docker.service）。它被停着时，只启动桌面程序也起不来引擎。 */
function dockerServiceState() {
  try {
    const out = execFileSync('sc.exe', ['query', 'com.docker.service'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /STATE\s*:\s*\d+\s+(\w+)/.exec(out)?.[1] || '';
  } catch { return ''; }
}

/** 尝试把引擎服务拉起来；普通权限会失败，返回 false 并由调用方给出可操作提示。 */
function ensureDockerService() {
  const state = dockerServiceState();
  if (state === 'RUNNING') return true;
  if (!state) return false;
  try {
    execFileSync('sc.exe', ['start', 'com.docker.service'], {
      encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: 'ignore',
    });
    pushLog('console', 'Docker 引擎服务 com.docker.service 已拉起');
    return true;
  } catch (err) {
    pushLog('console', 'Docker 引擎服务是停止的，自动启动失败（多半是控制台没有管理员权限）：请用管理员模式启动控制台，或先手动启动 Docker Desktop', 'warn');
    return false;
  }
}

async function waitDockerReady(docker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (dockerReady(docker)) return true;
    await sleep(3000);
  }
  return false;
}

/** QQ.exe 进程列表（Framework 模式下 NapCat 寄生在 QQ.exe 里）。 */
function qqProcessIds() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', timeout: 6000, windowsHide: true,
    });
    return out.split(/\r?\n/)
      .map((line) => /^"QQ\.exe","(\d+)"/i.exec(line.trim())?.[1])
      .filter(Boolean)
      .map(Number);
  } catch { return []; }
}

/**
 * Framework 模式要注入的 QQ.exe。
 * 顺序：config.json 的 unifiedConsole.napcatQQPath → 注册表 Uninstall\QQ 的 UninstallString
 * （和 NapCat 官方 napiLoader.bat 同一套解析：D:\Uninstall.exe → D:\QQ.exe）→ D:\QQ.exe。
 */
// ── NapCat WebUI「基础信息」同款：系统信息 / CPU / 内存 / 网络配置计数 ──────
let sysInfoCache = { at: 0, data: null };
let qqVerCache = { at: 0, value: '' };
let cpuPrevSnap = null;

function qqExeVersion() {
  if (Date.now() - qqVerCache.at < 3600_000) return qqVerCache.value;
  const exe = napcatQQExe();
  if (exe) {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.FileVersion`],
      { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
      if (out) qqVerCache = { at: Date.now(), value: out };
    } catch { /* 忽略 */ }
  }
  return qqVerCache.value;
}

function cpuUsagePct() {
  const cpus = os.cpus();
  const total = cpus.reduce((a, c) => a + c.times.user + c.times.nice + c.times.sys + c.times.idle, 0);
  const idle = cpus.reduce((a, c) => a + c.times.idle, 0);
  let pct = 0;
  if (cpuPrevSnap) {
    const dt = total - cpuPrevSnap.total;
    const di = idle - cpuPrevSnap.idle;
    if (dt > 0) pct = Math.max(0, Math.min(100, (1 - di / dt) * 100));
  }
  cpuPrevSnap = { total, idle };
  return Math.round(pct * 10) / 10;
}

async function napcatSysInfo() {
  if (sysInfoCache.data && Date.now() - sysInfoCache.at < 8000) return sysInfoCache.data;
  let napcatVersion = '';
  for (let attempt = 1; attempt <= 2 && !napcatVersion; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${paths.napcatHttpPort}/get_version_info`, { signal: AbortSignal.timeout(2500) });
      const j = await res.json().catch(() => null);
      napcatVersion = String(j?.data?.app_version || '');
    } catch { /* 下一次再试 */ }
    if (!napcatVersion) await sleep(600);
  }
  let network = { httpServers: 0, httpClients: 0, wsServers: 0, wsClients: 0 };
  try {
    const cfgDir = path.join(paths.napcatDir, 'config');
    const files = fs.existsSync(cfgDir) ? fs.readdirSync(cfgDir).filter((n) => /^onebot11_.*\.json$/i.test(n)) : [];
    const target = files.find((n) => n.includes(String(paths.napcatQQ))) || files[0];
    const raw = target ? fs.readFileSync(path.join(cfgDir, target), 'utf8').replace(/^\uFEFF/, '') : '';
    const cfg = raw ? JSON.parse(raw) : null;
    network = {
      httpServers: (cfg?.network?.httpServers || []).length,
      httpClients: (cfg?.network?.httpClients || []).length,
      wsServers: (cfg?.network?.websocketServers || []).length,
      wsClients: (cfg?.network?.websocketClients || []).length,
    };
  } catch { /* 忽略 */ }
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const qqPid = pidForPort(paths.napcatWsPort) || pidForPort(paths.napcatWebuiPort) || '';
  let qqMem = 0;
  if (qqPid) { const map = queryProcesses([qqPid]); qqMem = map[String(qqPid)]?.mem || 0; }
  // CPU 使用率按两次采样差值算：没有基准就先采一次、等 250ms 再采
  if (!cpuPrevSnap) { cpuUsagePct(); await sleep(250); }
  const cpuLoadPct = cpuUsagePct();
  const data = {
    ok: true,
    napcatVersion,
    qqVersion: qqExeVersion(),
    webuiVersion: 'Next',
    osVersion: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpu: { model: String(cpus[0]?.model || '').trim(), logical: cpus.length, mhz: cpus[0]?.speed || 0, loadPct: cpuLoadPct },
    memory: {
      totalMB: Math.round(totalMem / 1048576),
      freeMB: Math.round(freeMem / 1048576),
      usedMB: Math.round((totalMem - freeMem) / 1048576),
      usedPct: Math.round((1 - freeMem / totalMem) * 1000) / 10,
    },
    qq: { pid: qqPid, memMB: Math.round(qqMem / 1048576) },
    network,
    generatedAt: Date.now(),
  };
  sysInfoCache = { at: Date.now(), data };
  return data;
}

function napcatQQExe() {
  const explicit = String(paths.unified?.napcatQQPath || '').trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [];
  try {
    const out = execFileSync('reg', ['query',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ', '/v', 'UninstallString',
    ], { encoding: 'utf8', timeout: 6000, windowsHide: true });
    const m = /([A-Za-z]:\\[^\r\n"]*?)\\Uninstall\.exe/i.exec(out);
    if (m) candidates.push(path.join(m[1], 'QQ.exe'));
  } catch { /* 注册表没有该项就往下兜底 */ }
  candidates.push('D:\\QQ.exe');
  return candidates.find((file) => fs.existsSync(file)) || '';
}

// 日志轮转（2026-11-12）：DSH/bridge 的 stdout 是 detached 直接重定向到文件的，
// 只追加不截断。实测 state/dsh-child.log 累积到 109MB（74 万行，其中 6.6 万条是
// 同一个第三方插件报错），既占磁盘又拖慢「实时日志」的 tail。这里在每次拉起服务
// 前检查大小，超过阈值就把整份归档为 .1，原文件只留末尾一小段继续写。
// 阈值可用 QQB_LOG_ROTATE_BYTES 覆盖（运维调参 / 测试用），默认 50MB。
const LOG_ROTATE_BYTES = Number(process.env.QQB_LOG_ROTATE_BYTES) || 50 * 1024 * 1024;
const LOG_KEEP_BYTES = Number(process.env.QQB_LOG_KEEP_BYTES) || 5 * 1024 * 1024;

function rotateIfLarge(file) {
  if (!file) return;
  let st = null;
  try { st = fs.statSync(file); } catch { return; }
  if (!st.isFile() || st.size <= LOG_ROTATE_BYTES) return;

  // 归档前先做一次全量脱敏：.1 是原文件改名而来，若不先擦掉，历史上写进去的
  // DSH 登录 token 会原封不动留在归档里（P0-1 只擦当前文件等于白做）。
  scrubSecretsInFile(file, Infinity);

  const keep = Math.min(LOG_KEEP_BYTES, st.size);
  const start = st.size - keep;
  let tailBuf = null;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(keep);
    const read = fs.readSync(fd, buf, 0, keep, start);
    fs.closeSync(fd);
    tailBuf = buf.subarray(0, read);
  } catch { tailBuf = null; }

  // 归档整份（覆盖上一份归档），再把尾部写回原文件——尾部不含历史 token 行，
  // 但为了保险仍然过一次脱敏。
  try { fs.renameSync(file, `${file}.1`); } catch { /* 忽略：归档失败就继续，下面的写入会覆盖 */ }
  try {
    let body = tailBuf ?? Buffer.alloc(0);
    const nl = body.indexOf(0x0a);
    if (nl >= 0 && nl < body.length - 1) body = body.subarray(nl + 1); // 从整行开始，避免半行
    fs.writeFileSync(file, redactSecrets(body.toString('utf8')), 'utf8');
  } catch {
    try { fs.writeFileSync(file, '', 'utf8'); } catch { /* 忽略 */ }
  }
  // tail 偏移必须重置：文件变小后若沿用旧 offset，tailFile 会误判成轮转并回放
  tailState.delete(file);
  pushLog('console', `日志轮转：${path.basename(file)} 超过 ${Math.round(LOG_ROTATE_BYTES / 1024 / 1024)}MB，已归档为 ${path.basename(file)}.1，保留末尾 ${Math.round(LOG_KEEP_BYTES / 1024 / 1024)}MB`, 'warn');
}

function spawnLogged(name, command, args, options = {}) {
  // 关键：bridge / DSH 会把 stdout 写进管道。控制台进程一退出，管道断开 → 子进程写 stdout
  // 触发 EPIPE 直接挂掉（曾导致每次重启 console 都带走 bot 服务）。所以这两个服务改成
  // 「stdout/stderr 直接重定向到日志文件 + detached」：控制台退出不影响它们，
  // 控制台再用 tailFile 读这个文件补回实时日志展示。
  const logFile = options.logFile ? String(options.logFile) : '';
  let stdio = ['ignore', 'pipe', 'pipe'];
  let logFd = null;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      rotateIfLarge(logFile);
      logFd = fs.openSync(logFile, 'a');
      stdio = ['ignore', logFd, logFd];
    } catch (err) {
      pushLog('console', `${name} 日志重定向失败（回退管道）：${err.message}`, 'warn');
      logFd = null;
      stdio = ['ignore', 'pipe', 'pipe'];
    }
  }
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio,
    windowsHide: true,
    // 无管道 + detached：父进程退出（或被 Ctrl+C 广播）都不连带子进程
    detached: Boolean(logFile) || options.detached === true,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (logFd !== null) {
    // 句柄已被子进程继承，父进程这一份可以关掉，避免句柄泄漏
    try { fs.closeSync(logFd); } catch { /* 忽略 */ }
  }
  children[name] = child;
  const feed = (buf) => {
    const raw = buf.toString('utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      // 账号被踢下线：NapCat 不会自己恢复，重启也救不了，需要重新扫码登录。
      if (name === 'napcat' && /账号状态变更为离线|账号已离线/.test(line)) {
        const within = Date.now() - napcatOfflineNotice.at < 5 * 60 * 1000;
        napcatOfflineNotice = { at: Date.now(), count: within ? napcatOfflineNotice.count + 1 : 1 };
      }
      if (name === 'napcat' && /KickedOffLine|下线通知|登录已失效/.test(line)) {
        const within = Date.now() - napcatKickInfo.at < 30 * 60 * 1000;
        napcatKickInfo = {
          at: Date.now(),
          count: within ? napcatKickInfo.count + 1 : 1,
          text: line.trim().slice(0, 160),
        };
        pushLog('console', `⚠️ QQ 账号被踢下线（30 分钟内第 ${napcatKickInfo.count} 次）：需要重新扫码登录。${napcatKickInfo.count >= 2 ? '已暂停自动重启，避免无效循环。' : ''}`, 'error');
        recordNapcatEvent('kick', line.trim().slice(0, 160));
      }
      // NapCat 容器会周期性输出纯十六进制摘要行（日志完整性校验），对排查没用，直接丢掉
      if (/^[0-9a-f]{32,128}$/i.test(line.trim())) continue;

      pushLog(name, line);
    }
  };
  // 桥接自己把日志写进 state/bridge.log，控制台靠 tail 文件展示，避免每条重复两遍；
  // 只有它崩溃前的 stderr（没进日志文件的那部分）才直接展示。
  if (options.pipeStdout !== false) child.stdout?.on('data', feed);
  child.stderr?.on('data', feed);
  child.on('error', (err) => pushLog(name, `进程启动失败：${err.message}`, 'error'));
  child.on('exit', (code, signal) => {
    const expected = expectedStops.delete(name);
    if (expected) {
      pushLog('console', `${name} 已停止（重启/停止请求，退出码 ${code ?? 0}）`);
    } else {
      pushLog('console', `${name} 进程退出（code=${code ?? 0}${signal ? `，signal=${signal}` : ''}）`, code === 0 ? 'info' : 'warn');
    }
    if (children[name] === child) children[name] = null;
    broadcastStatus();
  });
  if (logFile) {
    // 脱离父进程的事件循环引用：控制台退出时不等它，子进程继续跑
    try { child.unref(); } catch { /* 忽略 */ }
  }
  pushLog('console', `已拉起 ${name}（PID ${child.pid}）：${path.basename(command)} ${args.join(' ').slice(0, 160)}${logFile ? ` · 日志→${path.basename(logFile)}` : ''}`);
  if (logFile) {
    // DSH 启动时会把带 token 的登录 URL 打到 stdout，而 stdout 是直写文件的
    // （pushLog 的脱敏覆盖不到落盘那一份）。启动后补扫两次，把文件里的密钥原地覆写。
    for (const delay of [3000, 20000]) {
      const timer = setTimeout(() => {
        const n = scrubSecretsInFile(logFile);
        if (n > 0) pushLog('console', `日志脱敏：${path.basename(logFile)} 中 ${n} 处密钥已原地覆写`, 'warn');
      }, delay);
      timer?.unref?.();
    }
  }
  return child;
}

// ---------------------------------------------------------------- 服务启停

/**
 * 等 NapCat 进入可用状态。
 * 返回 'ws'（已登录，3001 可连）/ 'webui'（已启动，等扫码）/ 'exited'（进程挂了）/ ''（超时）。
 * 关键：'webui' 是正常状态 —— 未登录时 NapCat 只开 WebUI 6099 等人扫码，
 * 不能当失败处理，更不能杀掉进程（否则永远等不到登录）。
 */
async function waitNapcatReady(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(paths.napcatWsPort)) return 'ws';
    if (await probe(paths.napcatWebuiPort)) return 'webui';
    if (child && child.exitCode !== null && child.exitCode !== undefined) return 'exited';
    await sleep(1200);
  }
  return '';
}

async function startNapcat() {
  if (await probe(paths.napcatWsPort)) { pushLog('console', 'NapCat 已在运行（3001 可连）'); return true; }
  if (starting.napcat) { pushLog('console', 'NapCat 正在启动中，跳过重复拉起'); return false; }
  starting.napcat = true;
  try {
    // Docker 模式：NapCat 在 Linux 容器里，用 docker compose 起，不看宿主机 QQ/node 进程
    if (napcatMode() === 'docker') return await startNapcatDocker();
    // Framework 模式：NapCat 注入已安装的 QQ，进程是 QQ.exe，不能按 node/index.js 拉起
    if (napcatMode() === 'framework') return await startNapcatFramework();
    // 已有 NapCat 进程但 WS 端口没通 = 正在启动或等待登录（扫码 / quick login）。
    // 这时再拉一个会抢同一个 QQ，两个 worker 互相把对方踢崩，永远起不来。
    const existing = napcatProcessIds();
    if (existing.length > 0) {
      pushLog('console', `检测到 NapCat 进程 ${existing.join(',')}，等待其完成启动/登录（不重复拉起）`, 'warn');
      const state = await waitNapcatReady(null, 25_000);
      if (state === 'ws') { pushLog('console', 'NapCat 已就绪（3001 可连）'); return true; }
      if (state === 'webui') { pushLog('console', 'NapCat 进程在跑，正在等待扫码登录（WebUI 6099）', 'warn'); return true; }
      pushLog('console', 'NapCat 进程在跑但 WS/WebUI 都未就绪，请查看 NapCat 日志', 'error');
      return false;
    }
    if (!(await clearStalePort(paths.napcatWsPort, 'NapCat'))) return false;
    const nodeExe = path.join(paths.napcatDir, 'node.exe');
    const entry = path.join(paths.napcatDir, 'index.js');
    if (!fs.existsSync(nodeExe) || !fs.existsSync(entry)) {
      pushLog('console', `NapCat 启动失败：找不到 ${nodeExe} 或 ${entry}`, 'error');
      return false;
    }
    const child = spawnLogged('napcat', nodeExe, [entry, '-q', paths.napcatQQ], { cwd: paths.napcatDir });
    // NapCat 有两种正常状态：
    //   1) 已登录 → WS(3001) 可连，成功；
    //   2) 未登录 → 打印二维码并开 WebUI(6099) 等人扫码，也是成功（进程要保留）。
    // 以前把「3001 没通」当超时，自愈又拉一个实例，两个实例抢同一个 QQ，
    // worker 互相踢下线（日志里的 Worker 退出码 1 循环），永远起不来。
    const state = await waitNapcatReady(child, 90_000);
    if (state === 'ws') { pushLog('console', 'NapCat 已就绪（3001 可连）'); return true; }
    if (state === 'webui') {
      pushLog('console', 'NapCat 已启动，正在等待扫码登录（二维码见日志或 napcat/shell/napcat/cache/qrcode.png；扫码后 3000/3001 自动就绪）', 'warn');
      return true;
    }
    if (state === 'exited') {
      pushLog('console', 'NapCat 进程已退出，启动失败', 'error');
    } else {
      pushLog('console', 'NapCat 启动超时（WS/WebUI 都未就绪），清理残留进程后交给自愈重试', 'error');
    }
    // 失败才清理；等待扫码时绝不走到这里
    try { if (child?.pid) killTree(child.pid); } catch { /* 忽略 */ }
    for (const id of napcatProcessIds()) { try { killTree(id); } catch { /* 忽略 */ } }
    return false;
  } finally {
    starting.napcat = false;
  }
}

/**
 * Framework 模式启动：napimain.exe 把 napiloader.dll 注入已安装的 QQ.exe（用桌面 QQ 的内核，
 * 本机 = QQ 9.9.36-53644），NapCat 随后在 QQ 进程里跑：先开 WebUI 6099 等扫码，
 * 登录成功后再开 OneBot 的 3000/3001。
 *
 * 与 Shell 的差异：napimain 拉起 QQ 后自己立刻退出，所以不能靠 child.exitCode 判断失败，
 * 只能看 6099/3001 是否监听。
 */
async function startNapcatFramework() {
  if (await probe(paths.napcatWsPort)) { pushLog('console', 'NapCat(Framework) 已在运行（3001 可连）'); return true; }
  if (await probe(paths.napcatWebuiPort)) {
    pushLog('console', 'NapCat(Framework) 在跑但未登录：WebUI 6099 已开，等待在 QQ 窗口扫码（不重复拉起）', 'warn');
    return true;
  }
  const launcher = path.join(paths.napcatDir, 'napimain.exe');
  const inject = path.join(paths.napcatDir, 'napiloader.dll');
  const main = path.join(paths.napcatDir, 'nativeLoader.cjs');
  const missing = [launcher, inject, main].filter((file) => !fs.existsSync(file));
  if (missing.length) {
    pushLog('console', `NapCat(Framework) 启动失败：${paths.napcatDir} 里缺少 ${missing.map((f) => path.basename(f)).join(' / ')}`, 'error');
    return false;
  }
  const qq = napcatQQExe();
  if (!qq) {
    pushLog('console', 'NapCat(Framework) 启动失败：找不到 QQ.exe，请在 config.json 设 unifiedConsole.napcatQQPath', 'error');
    return false;
  }
  // QQ 单实例：已有 QQ.exe 时再注入只会激活旧窗口/双实例互踢；
  // 但如果是卡死后留下的残留（内存 GB 级），必须清掉才能重新注入。
  const running = qqProcessIds();
  if (running.length) {
    const map = queryProcesses(running);
    let totalMem = 0;
    for (const pid of running) totalMem += map[String(pid)]?.mem || 0;
    if (totalMem > 1.0 * 1024 ** 3) {
      pushLog('console', `检测到 ${running.length} 个 QQ.exe（合计 ${fmtBytes(totalMem)}）且 3001/6099 未就绪，判定为卡死残留，自动清理后重新注入`, 'warn');
      for (const pid of running) { try { killTree(pid); } catch { /* 忽略 */ } }
      await sleep(2500);
    } else {
      pushLog('console', `检测到 QQ.exe 进程 ${running.join(',')}，但 3001/6099 都没开（桌面 QQ 或注入失败）。为避免双实例，本次不拉起；请先退出这些 QQ 再点启动`, 'warn');
      return false;
    }
  }
  pushLog('console', `NapCat(Framework) 注入启动：${qq} + ${path.basename(inject)}（QQ 会弹出登录窗口，扫码后 3000/3001 自动就绪）`);
  // DSH 沙箱会把工作区（含本目录）打上 Low 完整性标签；QQ 从 Low 目录加载注入的 napiloader.dll
  // 会在 QQNT.dll+0x26b6e3a 处以 0x80000003 秒崩（NapCat issue #2116 同款）。
  // 这里启动前幂等地把目录改回 Medium，避免换会话/重打标签后又崩。
  try {
    execFileSync('icacls', [paths.napcatDir, '/setintegritylevel', '(OI)(CI)M', '/T', '/C', '/Q'], {
      timeout: 60_000, windowsHide: true, stdio: 'ignore',
    });
  } catch (err) {
    pushLog('console', `NapCat(Framework)：修正目录完整性标签失败（${err.message}）；若 QQ 秒崩请手动跑 scripts\\napcat-framework-fix-label.ps1`, 'warn');
  }
  spawnLogged('napcat', launcher, [qq, inject, main.replace(/\\/g, '/')], { cwd: paths.napcatDir });
  const state = await waitNapcatReady(null, 120_000);
  if (state === 'ws') { pushLog('console', 'NapCat(Framework) 已就绪（3001 可连）'); return true; }
  if (state === 'webui') {
    // QQ 登录窗口一般停在“选择账号登录”。用 NapCat WebUI 的 SetQuickLogin 免交互登录；
    // 登录服务刚初始化时前几次常返回 Unauthorized，重试几次能显著提高免扫码成功率。
    let quickOk = false;
    let lastReason = '';
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const quick = await napcatQuickLogin(paths.napcatQQ);
      lastReason = quick.reason || '';
      if (quick.ok) {
        quickOk = true;
        pushLog('console', `NapCat(Framework) 快速登录已发起（第 ${attempt} 次，${quick.reason || 'success'}），等待 3001…`);
        if (await waitPort(paths.napcatWsPort, 45_000)) {
          pushLog('console', 'NapCat(Framework) 快速登录成功，3001 已就绪');
          return true;
        }
        pushLog('console', `NapCat(Framework) 快速登录已发起但 3001 未就绪（第 ${attempt} 次），继续重试…`, 'warn');
      } else {
        pushLog('console', `NapCat(Framework) 快速登录第 ${attempt} 次未成功（${lastReason || '无凭据'}），5 秒后重试…`, 'info');
      }
      await sleep(5000);
    }
    pushLog('console', `NapCat(Framework) 快速登录连续失败（${lastReason || '无凭据'}）：需要扫码。若经常失败，请确认该 QQ 没在手机/其他电脑上被顶下线。`, quickOk ? 'warn' : 'info');
    pushLog('console', 'NapCat(Framework) 已注入，正在等待扫码登录（扫码后 3000/3001 自动就绪）', 'warn');
    return true;
  }
  pushLog('console', 'NapCat(Framework) 启动超时（6099/3001 都未就绪）：看桌面是否弹出 QQ、事件日志是否有 QQ.exe 崩溃', 'error');
  return false;
}

/**
 * Docker 模式启动：docker compose up -d，把 NapCat 拉进 Linux 容器。
 * 与 Framework/Shell 的关键差异：
 *   · 容器里的 NapCat 是 Linux QQ 内核，不碰本机 Windows QQ，也就没有 9.9.31 的 onOpentelemetryInit 卡死；
 *   · 3001/6099 是 Docker Desktop 的端口转发在监听（com.docker.backend），所以停服务只能 `docker compose stop`，
 *     绝不能按 PID 杀监听进程，否则会把 Docker 的转发进程一起打挂；
 *   · 首次/容器不存在时由 compose 创建；数据在 napcat/docker/{config,qq,plugins} 里持久化。
 */
async function startNapcatDocker() {
  if (await probe(paths.napcatWsPort)) { pushLog('console', 'NapCat(Docker) 已在运行（3001 可连）'); return true; }
  const docker = dockerExe();
  if (!docker) {
    pushLog('console', 'NapCat(Docker) 启动失败：找不到 docker 命令。先装 Docker Desktop（scripts\\napcat-docker-install.ps1，装完必须重启电脑）', 'error');
    return false;
  }
  // 自启策略：qq-bridge 不再拉起 Docker Desktop。
  // Docker Desktop 一旦被拉起会弹面板，并可能在系统里留下自启动/恢复入口；
  // 需要 daemon 时由用户手动启动，控制台只提示，不代劳。
  if (!dockerReady(docker)) {
    pushLog('console', 'Docker Desktop 未运行：已禁用自动拉起（避免自启动/弹窗）。请手动启动 Docker Desktop 后重试。', 'warn');
    return false;
  }
  const composeFile = dockerComposePath();
  if (!fs.existsSync(composeFile)) {
    pushLog('console', `NapCat(Docker) 启动失败：找不到 ${composeFile}（先跑 scripts\\napcat-docker-prepare.mjs 生成挂载配置）`, 'error');
    return false;
  }
  try {
    const out = execFileSync(docker, ['compose', '-f', composeFile, 'up', '-d'], {
      encoding: 'utf8', timeout: 240_000, windowsHide: true, cwd: paths.napcatDir,
    });
    const last = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
    pushLog('console', `NapCat(Docker) docker compose up -d 完成${last ? `：${last}` : ''}`);
  } catch (err) {
    const detail = String(err.stderr || err.stdout || err.message || '').trim().split(/\r?\n/).slice(-3).join(' | ');
    pushLog('console', `NapCat(Docker) docker compose up 失败：${detail || '未知错误'}（Docker Desktop 需手动启动；镜像拉不下来就先配 Docker 镜像加速）`, 'error');
    return false;
  }
  ensureNapcatDockerLogStream();
  const state = await waitNapcatReady(null, 150_000);
  if (state === 'ws') { pushLog('console', 'NapCat(Docker) 已就绪（3001 可连）'); return true; }
  if (state === 'webui') {
    pushLog('console', 'NapCat(Docker) 容器已启动，等待扫码登录（跑 scripts\\napcat-docker-start.ps1 出二维码 PNG，或开 http://127.0.0.1:6099）', 'warn');
    return true;
  }
  pushLog('console', 'NapCat(Docker) 启动超时（6099/3001 都未就绪）：docker compose -f napcat/docker/compose.yaml logs --tail 80 看容器日志', 'error');
  return false;
}

/**
 * Framework 模式免交互登录：调 NapCat WebUI 的 /api/QQLogin/SetQuickLogin。
 * 凭据来自上一次成功扫码（写在 QQ 本地账号数据里）；失效时返回 {ok:false, reason}。
 */
async function napcatQuickLogin(uin) {
  const auth = await napcatWebuiLogin({});
  if (!auth.ok) return { ok: false, reason: auth.reason };
  try {
    const res = await fetch(`http://127.0.0.1:${auth.port}/api/QQLogin/SetQuickLogin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.credential}` },
      body: JSON.stringify({ uin: String(uin) }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    return { ok: data?.code === 0, reason: data?.message || '' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// DSH 启动路径白名单：dshExe 必须是安装根下的 DeepSeek Harness.exe，
// dshCli 必须是 app.asar/runtime 里的 dsh-desktop-host cli.js。
// 目的不是防 owner，而是防「拿到控制台 token 后改写 unifiedConsole.dshCli 拼执行链」。
function isTrustedDshRuntime(exePath, cliPath) {
  try {
    const exe = path.resolve(String(exePath || ''));
    const exeName = path.basename(exe).toLowerCase();
    if (exeName !== 'deepseek harness.exe' && exeName !== 'dsh.exe') return false;
    if (!fs.existsSync(exe)) return false;
    // 安装根旁边必须有 resources（app.asar 或 runtime 都在里面）。
    if (!fs.existsSync(path.join(path.dirname(exe), 'resources'))) return false;
    const cli = String(cliPath || '').replace(/\//g, '\\').toLowerCase();
    if (!path.isAbsolute(cli)) return false;
    if (!cli.endsWith('\\cli.js')) return false;
    if (!cli.includes('\\resources\\')) return false;
    if (!cli.includes('\\@deepseek-ai\\dsh-desktop-host\\')) return false;
    return true;
  } catch {
    return false;
  }
}

async function startDsh() {
  if (await probe(paths.dshPort)) { pushLog('console', `DSH Web 已在运行（${paths.dshPort} 可连）`); return true; }
  if (starting.dsh) { pushLog('console', 'DSH Web 正在启动中，跳过重复拉起'); return false; }
  starting.dsh = true;
  try {
    await waitPortGone(paths.dshPort, 15_000);
    if (!(await clearStalePort(paths.dshPort, 'DSH Web'))) return false;
    // cli.js 在 app.asar 里，普通 node 的 existsSync 看不到（asar 是虚拟归档），
    // 所以 cli 只做路径形状校验，exe 做存在性校验。
    if (!isTrustedDshRuntime(paths.dshExe, paths.dshCli)) {
      pushLog('console', `DSH 启动失败：dshExe/dshCli 不在受信任的安装路径形状内（${paths.dshExe} / ${paths.dshCli}）`, 'error');
      return false;
    }
    spawnLogged('dsh', paths.dshExe, [
      '--expose-internals', paths.dshCli,
      '--profile', 'web',
      '--port', String(paths.dshPort),
      '--no-open',
    ], { cwd: ROOT, env: { ELECTRON_RUN_AS_NODE: '1' }, logFile: DSH_CHILD_LOG });
    const ok = await waitPort(paths.dshPort, 120_000);
    if (!ok) pushLog('console', 'DSH Web 启动超时（120s 内未监听，看 dsh-child.log）', 'error');
    return ok;
  } finally {
    starting.dsh = false;
  }
}

async function startBridge() {
  if (await probe(paths.bridgePort)) { pushLog('console', `桥接已在运行（${paths.bridgePort} 可连）`); return true; }
  if (starting.bridge) { pushLog('console', '桥接正在启动中，跳过重复拉起'); return false; }
  starting.bridge = true;
  try {
    // 刚重启时旧进程可能还在优雅退出：先等它把端口放开，避免误报“残留进程占用”。
    await waitPortGone(paths.bridgePort, 15_000);
    if (!(await clearStalePort(paths.bridgePort, '桥接'))) return false;
    spawnLogged('bridge', process.execPath, [BRIDGE_ENTRY], {
      cwd: ROOT,
      pipeStdout: false,
      logFile: BRIDGE_CHILD_LOG,
    });
    const ok = await waitPort(paths.bridgePort, 40_000);
    if (!ok) pushLog('console', '桥接启动超时（看实时日志）', 'error');
    return ok;
  } finally {
    starting.bridge = false;
  }
}

async function startAll() {
  pushLog('console', '开始启动：DSH → NapCat → 桥接 → WorkBuddy LAN');
  const dsh = await startDsh();
  const napcat = await startNapcat();
  const bridge = await startBridge();
  // WorkBuddy LAN 是可选的独立网关：未配置目录或用户关掉时不参与“全部启动”
  let workbuddy = null;
  if (paths.workbuddyDir && paths.workbuddyAutoStart) workbuddy = await startWorkbuddy();
  await broadcastStatus();
  return {
    ok: dsh && napcat && bridge && (workbuddy === null || workbuddy),
    message: `DSH ${dsh ? '✓' : '✗'} / NapCat ${napcat ? '✓' : '✗'} / 桥接 ${bridge ? '✓' : '✗'}${workbuddy === null ? '' : ` / WorkBuddy ${workbuddy ? '✓' : '✗'}`}`,
  };
}

async function stopService(name) {
  expectedStops.add(name);
  const child = children[name];
  if (child) { killTree(child.pid); children[name] = null; }
  // WorkBuddy LAN 是独立进程：按监听端口找到它结束即可（不要按镜像名全杀，可能误伤别的实例）
  if (name === 'workbuddy') {
    const pid = pidForPort(paths.workbuddyPort);
    if (pid) killTree(pid);
    await waitPortGone(paths.workbuddyPort, 8000);
    expectedStops.delete(name);
    pushLog('console', pid ? `已停止 WorkBuddy LAN（PID ${pid}）` : '已停止 WorkBuddy LAN（本来就没在运行）');
    broadcastStatus().catch(() => {});
    return true;
  }
  // Docker 模式：3001/6099 是 Docker Desktop 的端口转发进程在监听，按 PID 杀会连带打挂 docker，
  // 只能交给 compose 停容器（数据卷保留，下次 start 不用重新扫码）。
  if (name === 'napcat' && napcatMode() === 'docker') {
    const docker = dockerExe();
    if (!docker) {
      pushLog('console', '停止 NapCat(Docker)：找不到 docker 命令，未做任何操作', 'warn');
      return true;
    }
    try {
      execFileSync(docker, ['compose', '-f', dockerComposePath(), 'stop'], {
        encoding: 'utf8', timeout: 120_000, windowsHide: true, cwd: paths.napcatDir,
      });
      pushLog('console', `已停止 NapCat(Docker) 容器 ${dockerContainerName()}（数据保留，可再启动恢复）`);
    } catch (err) {
      const detail = String(err.stderr || err.message || '').trim().split(/\r?\n/).slice(-2).join(' | ');
      pushLog('console', `停止 NapCat(Docker) 失败：${detail}`, 'error');
    }
    broadcastStatus().catch(() => {});
    return true;
  }
  // Framework 模式下 NapCat 寄生在 QQ.exe 里：只杀监听 3001/6099 的那个 QQ，
  // 不能见 QQ 就杀（用户自己的桌面 QQ 可能正开着）。
  if (name === 'napcat' && napcatMode() === 'framework') {
    const pids = new Set();
    for (const port of [paths.napcatWsPort, paths.napcatWebuiPort]) {
      const pid = pidForPort(port);
      if (pid) pids.add(Number(pid));
    }
    for (const pid of pids) killTree(pid);
    pushLog('console', pids.size
      ? `已停止 NapCat(Framework)（QQ PID ${[...pids].join(',')}）`
      : '已停止 NapCat(Framework)：没有找到监听 3001/6099 的 QQ 进程（可能本来就没起）');
    broadcastStatus().catch(() => {});
    return true;
  }
  const port = name === 'napcat' ? paths.napcatWsPort : name === 'bridge' ? paths.bridgePort : paths.dshPort;
  const pid = pidForPort(port);
  if (pid) killTree(pid);
  // NapCat 是父进程 + worker 两层，父进程会重启 worker，必须一起清
  if (name === 'napcat') {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*napcat*' } | Select-Object -ExpandProperty Id",
      ], { windowsHide: true, encoding: 'utf8', timeout: 8000 });
      for (const line of out.split(/\r?\n/)) {
        if (/^\d+$/.test(line.trim())) killTree(line.trim());
      }
    } catch { /* 忽略 */ }
  }
  const released = await waitPortGone(port, 12_000);
  pushLog('console', `已停止 ${name}${released ? '' : '（端口仍被占用，启动前会再清理）'}`, released ? 'info' : 'warn');
  return true;
}

async function stopAll() {
  pushLog('console', '开始停止：桥接 → NapCat → DSH → WorkBuddy LAN');
  await stopService('bridge');
  await stopService('napcat');
  await stopService('dsh');
  if (paths.workbuddyDir) await stopService('workbuddy');
  await sleep(800);
  await broadcastStatus();
  return { ok: true, message: '已停止' };
}

// ---------------------------------------------------------------- 自愈守护
//
// 背景：2026-10-25 出过一次「NapCat + 桥接 悄悄消失、控制台/DSH 还活着」，
// 37 分钟后才被人发现。这里每 30s 探活三个端口，掉线就自动拉起：
//   · 顺序 DSH → NapCat → 桥接（桥接依赖前两者）
//   · 同一服务 90s 内最多拉一次：失败也进冷却，避免失败风暴
//   · 开关：config.json 的 unifiedConsole.autoHeal（默认 true）
//   · 定时器只在 server.listen 成功后启动（见文件末尾），避免启动阶段
//     和手动「全部启动」抢同一个端口
//   · 手动启停进行中时本轮直接跳过（lifecycleDepth > 0）

const autoHealState = new Map(); // key -> { lastAttemptAt, lastResult, lastSkipAt }
let autoHealTimer = null;
let autoHealRunning = false;
let autoHealEnabledLogged = null; // 上一次日志里记录的开关状态，用来只在「状态变化」时打一条
let lifecycleDepth = 0;          // 手动启停正在进行时的深度（>0 表示别插手）

/** 手动启停包一层：期间自愈不插手，避免两边同时拉同一个服务。 */
async function withLifecycle(fn) {
  lifecycleDepth += 1;
  try { return await fn(); }
  finally { lifecycleDepth -= 1; }
}

function autoHealPort(key) {
  if (key === 'dsh') return paths.dshPort;
  if (key === 'napcat') return paths.napcatWsPort;
  if (key === 'workbuddy') return paths.workbuddyPort;
  return paths.bridgePort;
}

function autoHealStart(key) {
  if (key === 'dsh') return startDsh();
  if (key === 'napcat') return startNapcat();
  if (key === 'workbuddy') return startWorkbuddy();
  return startBridge();
}

function autoHealEntry(key) {
  let st = autoHealState.get(key);
  if (!st) {
    st = { lastAttemptAt: 0, lastResult: null, lastSkipAt: 0, failCount: 0 };
    autoHealState.set(key, st);
  }
  return st;
}

/** 供 /api/status 观测（前端不强制使用，排查时很有用）。 */
function autoHealSnapshot() {
  const services = {};
  for (const svc of AUTOHEAL_SERVICES) {
    const st = autoHealState.get(svc.key);
    services[svc.key] = {
      port: autoHealPort(svc.key),
      lastAttemptAt: st?.lastAttemptAt ?? 0,
      lastResult: st?.lastResult ?? null,
    };
  }
  return {
    enabled: autoHealEnabled(paths.unified),
    running: autoHealRunning,
    intervalMs: AUTOHEAL_INTERVAL_MS,
    cooldownMs: AUTOHEAL_COOLDOWN_MS,
    services,
  };
}

/**
 * 逐个测试 WorkBuddy 网关的模型（并发 2），结果写入 state/workbuddy-model-test.json，
 * 让控制台「实测」列/模型列表徽标刷新后仍然保留（浏览器 localStorage 会被清、换设备也同步）。
 */
async function runWorkbuddyModelTests() {
  const health = await probeWorkbuddy();
  if (!health.up) return { ok: false, message: 'WorkBuddy LAN 未运行，先点「启动」' };
  const key = workbuddyApiKey();
  if (!key) return { ok: false, message: '读不到 WorkBuddy LAN 的 API Key' };
  const list = await workbuddyModels();
  const ids = (list.ids || []).slice();
  if (!ids.length) return { ok: false, message: '网关没有返回模型列表' };
  const MEDIA = new Set(['hy-image-3.5', 'kling-video-v3']);
  const results = {};
  const queue = ids.filter((m) => !MEDIA.has(m));
  const worker = async () => {
    while (queue.length) {
      const m = queue.shift();
      const t0 = Date.now();
      try {
        const res = await fetch(`http://127.0.0.1:${paths.workbuddyPort}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: m, messages: [{ role: 'user', content: '只回复两个字：可用' }], max_tokens: 64 }),
          signal: AbortSignal.timeout(60_000),
        });
        const data = await res.json().catch(() => null);
        results[m] = res.ok
          ? { ok: true, ms: Date.now() - t0, reply: String(data?.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').slice(0, 40) }
          : { ok: false, ms: Date.now() - t0, note: String(data?.error?.message || `HTTP ${res.status}`).slice(0, 160) };
      } catch (err) {
        results[m] = { ok: false, ms: Date.now() - t0, note: String(err.message || err).slice(0, 160) };
      }
    }
  };
  await Promise.all([worker(), worker()]);
  for (const m of ids) if (MEDIA.has(m)) results[m] = { ok: false, ms: 0, note: '媒体生成模型，不适用于聊天接口' };
  const payload = { ok: true, at: Date.now(), count: ids.length, results };
  try { fs.writeFileSync(WB_TEST_FILE, JSON.stringify(payload, null, 2), 'utf8'); } catch { /* 忽略 */ }
  return payload;
}

/** NapCat WebUI 的 HTTP 探活：端口在监听不等于服务活着（卡死时 TCP 通、HTTP 超时）。 */
async function probeNapcatWebuiHttp() {
  try {
    const res = await fetch(`http://127.0.0.1:${paths.napcatWebuiPort}/api/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * NapCat 卡死看门狗（Framework 模式）。
 *
 * 背景：2026-10-25 反复出现「NapCat 跑一段时间后内存膨胀 → 6099/3001 卡死、QQ 掉线、
 * 桥接发消息超时」。典型症状是**端口还在监听但 HTTP 完全不响应**，所以用 HTTP 探活判断。
 *   · WebUI HTTP 连续两轮（约 60 秒）不通 → 真卡死 → 重启
 *   · 或 内存 > 2.5GB（明显泄漏）→ 提前重启
 * 重启 = 结束所有 QQ.exe（含卡死残留）→ 重新注入 → 自动快速登录；冷却 10 分钟。
 *
 * @returns {Promise<boolean>} true = 本轮已处理（调用方跳过常规自愈）
 */
async function maybeRestartHungNapcat() {
  if (napcatMode() !== 'framework') return false;
  if (starting.napcat) return true;       // 正在启动/重启，别插一手
  // 短时间内反复被踢下线：重启/快速登录都救不回来（除非别处不再抢号），暂停自动重启
  if (napcatKickInfo.count >= 2 && Date.now() - napcatKickInfo.at < 10 * 60 * 1000) {
    pushLogOnce('napcat-kick-pause', 'console', 'NapCat 反复被踢下线，已暂停自动重启：请点「重启」并扫码，或检查是否在手机/其他电脑登录了同一 QQ', 'warn');
    return true;
  }
  const wsUp = await probe(paths.napcatWsPort);
  const webuiUp = await probe(paths.napcatWebuiPort);
  const webuiHttp = await probeNapcatWebuiHttp();
  // 端口在监听 ≠ 服务活着：卡死时 TCP 通但 HTTP 超时，以 HTTP 探活为准
  if (wsUp || webuiHttp) napcatWebuiFails = 0;
  else napcatWebuiFails += 1;
  // WS（3001）通说明 OneBot 正在工作：此时 WebUI HTTP 探测失败（鉴权/慢/临时 5xx）不代表卡死。
  // 2026-10-26 的"频繁掉线"根因之一就是这里误杀正常实例。
  if (wsUp && !webuiHttp) pushLogOnce('napcat-webui-probe-only', 'console', 'NapCat WebUI HTTP 探测失败但 WS 正常，判定存活（不重启）', 'debug');

  const pid = pidForPort(paths.napcatWsPort) || pidForPort(paths.napcatWebuiPort) || '';
  let mem = 0;
  if (pid) {
    const map = queryProcesses([pid]);
    mem = map[String(pid)]?.mem || 0;
  } else {
    // 没监听端口时，看所有 QQ.exe 的总内存（卡死实例往往还在，只是不响应）
    const all = qqProcessIds();
    if (all.length) {
      const map = queryProcesses(all);
      for (const id of all) mem += map[String(id)]?.mem || 0;
    }
  }

  // 触发条件（收紧，避免误杀"内存大但还活着"的正常实例）：
  //   · 两个端口连续两轮都不通（真卡死）
  //   · 或 内存 > 2.5GB（明显泄漏，早晚卡死，提前重启）
  //   · 或 内存 > 1.2GB 且任一端口不通
  // 连续两轮（约 60 秒）WebUI HTTP 不通 = 真卡死（端口可能还听着，但服务已死）
  const hung = !wsUp && napcatWebuiFails >= 2;
  const memHuge = mem > 2.5 * 1024 ** 3; // 内存泄漏提前处理
  // 账号掉登录（SelfOffline 等，不是被踢）：NapCat 进程还活着但账号离线，也必须拉起重登
  let offline = false;
  try {
    const info = await napcatStatus();
    const login = info?.login || {};
    const offlineNotices = napcatOfflineNotice.count >= 2 && Date.now() - napcatOfflineNotice.at < 5 * 60 * 1000;
    offline = (login.isLogin === false && String(login.loginPhase || '') === 'offline') || offlineNotices;
    if (offlineNotices && !(login.isLogin === false)) {
      pushLogOnce('napcat-offline-notice', 'console', `NapCat 连续上报账号离线（${napcatOfflineNotice.count} 次/5 分钟），按掉登录处理并重启`, 'warn');
    }
  } catch { /* 忽略 */ }
  if (!hung && !memHuge && !offline) return false;
  if (Date.now() - napcatMemRestartAt < NAPCAT_MEM_RESTART_COOLDOWN_MS) {
    return true; // 冷却期内：已处理过，跳过常规自愈，避免反复拉起
  }
  napcatMemRestartAt = Date.now();
  pushLog('console', offline
    ? `⚠️ NapCat 账号掉登录（SelfOffline，未收到被踢通知）：自动重启并重新登录…`
    : `⚠️ NapCat 疑似卡死（内存 ${fmtBytes(mem)}，WS ${wsUp ? '通' : '不通'}，WebUI ${webuiUp ? '通' : '不通'}），自动结束 QQ 并重新注入…`, 'warn');
  recordNapcatEvent('restart', offline
    ? '账号掉登录（SelfOffline）：自动重启重登'
    : `疑似卡死（内存 ${fmtBytes(mem)}，WS ${wsUp ? '通' : '不通'}）：自动重启`);
  for (const id of qqProcessIds()) { try { killTree(id); } catch { /* 忽略 */ } }
  await sleep(2500);
  try {
    const ok = await startNapcat();
    pushLog('console', ok ? 'NapCat 自动重启完成（自动快速登录中）' : 'NapCat 自动重启失败，请手动点「重启」并检查日志', ok ? 'info' : 'error');
  } catch (err) {
    pushLog('console', `NapCat 自动重启异常：${err.message}`, 'error');
  }
  return true;
}

/** 一轮检查：顺序探活 → 掉线且不在冷却期才拉起。 */
// ── QQ 账号离线自愈（Docker 模式）───────────────────────────────────────
// 端口都在、WS 也能重连，但账号本身掉线（如等待扫码）时，常规自愈看不出来：
// 它只探端口，于是机器人一直发不出消息。这里用 OneBot 的 get_login_info 判断账号
// 是否真的在线；离线超过 90 秒就尝试 NapCat WebUI 的快速登录（有保存的登录凭据），
// 失败每 5 分钟重试一次，并在日志里提示去「查看登录」扫码。
// 2026-11-22：账号级掉线一天出现 10 次（07:22/08:07/10:03/13:50/19:18/20:33…），旧的
// 「离线 90 秒才快登 + 失败后冷却 5 分钟」让每次掉线要 1~9 分钟才回来。QQ 掉线后自己
// 不会恢复，重启容器也无济于事，只有快速登录能救；所以把首试压到 15 秒、失败每 60 秒
// 重试一次，连续 3 次没起来才提示扫码（那说明凭据失效/被别处挤掉了，快登救不了）。
const NAPCAT_OFFLINE_RELOGIN_MS = 15_000;
const NAPCAT_RELOGIN_COOLDOWN_MS = 60_000;
let napcatOfflineSince = 0;
let napcatReloginAt = 0;
let napcatReloginFails = 0;

async function maybeReloginNapcat() {
  if (napcatMode() !== 'docker') return false;
  if (starting.napcat) return false;
  if (!(await probe(paths.napcatHttpPort))) { napcatOfflineSince = 0; return false; }
  const info = await napcatOneBotInfo({ force: true });
  if (info.ok) {
    if (napcatOfflineSince) pushLog('console', `QQ 已重新上线（${info.nick || info.uin || paths.napcatQQ}）`);
    napcatOfflineSince = 0;
    napcatReloginFails = 0;
    return false;
  }
  if (!napcatOfflineSince) {
    napcatOfflineSince = Date.now();
    // 第一次发现离线时把 OneBot 的原文记下来：下次再掉线，就能在 NapCat 页的掉线记录里
    // 看到到底是「等待扫码」还是「登录态失效」，不用再猜。
    recordNapcatEvent('offline', `账号离线（OneBot：${info.error || '无返回'}）`);
    return false;
  }
  const offlineMs = Date.now() - napcatOfflineSince;
  if (offlineMs < NAPCAT_OFFLINE_RELOGIN_MS) return false;
  const now = Date.now();
  if (now - napcatReloginAt < NAPCAT_RELOGIN_COOLDOWN_MS) return false;
  napcatReloginAt = now;
  pushLog('console', `QQ 账号离线 ${Math.round(offlineMs / 1000)}s（${info.error || 'OneBot 未返回在线'}），尝试用已保存的账号快速登录…`, 'warn');
  let r;
  try { r = await napcatQuickLogin(paths.napcatQQ); } catch (err) { r = { ok: false, reason: err?.message || String(err) }; }
  if (r.ok) {
    napcatReloginFails = 0;
    pushLog('console', '快速登录已触发，等待 QQ 上线…');
  } else {
    napcatReloginFails += 1;
    pushLog('console', `快速登录失败（第 ${napcatReloginFails} 次）：${r.reason || '未知原因'}（可到 NapCat 卡片点「查看登录」扫码）`, 'warn');
    if (napcatReloginFails >= 3) {
      pushLogOnce('napcat-relogin-scan', 'console', `连续 ${napcatReloginFails} 次快速登录没生效：登录凭据大概率已失效，需要扫码重新登录（NapCat 页 →「查看登录」）；另外检查手机/别的电脑是否登录了同一个 QQ，会把机器人挤下线`, 'error');
      recordNapcatEvent('relogin-fail', `快速登录连续失败 ${napcatReloginFails} 次：${r.reason || '未知原因'}`);
    }
  }
  return true;
}

async function autoHealTick() {
  if (autoHealRunning) return;            // 上一轮还没结束（拉 DSH/NapCat 可能要几十秒）
  if (lifecycleDepth > 0) return;         // 手动启停中：让手动操作自己收尾
  autoHealRunning = true;
  try {
    // config.json 坏了就先不动：runtimePaths() 读不到配置会退回默认端口，
    // 照默认端口去拉服务可能拉错实例，比不拉更糟。
    const cfgCheck = readConfigSafe();
    if (!cfgCheck.ok) {
      pushLogOnce(`autoheal-config:${cfgCheck.error}`, 'console', `自愈：config.json 解析失败，本轮跳过（${cfgCheck.error}）`, 'error');
      return;
    }
    // 每轮重读 config.json：autoHeal / 端口改了不用重启控制台
    paths = runtimePaths();
    if (!autoHealEnabled(paths.unified)) {
      if (autoHealEnabledLogged !== false) {
        pushLog('console', '自愈：unifiedConsole.autoHeal=false，守护已暂停（改回 true 后下一轮自动恢复）', 'warn');
      }
      autoHealEnabledLogged = false;
      return;
    }
    if (autoHealEnabledLogged === false) pushLog('console', '自愈：unifiedConsole.autoHeal=true，守护恢复检查');
    autoHealEnabledLogged = true;

    // 账号级掉线（端口正常但 QQ 离线）不在常规自愈覆盖范围内，单独处理。
    await maybeReloginNapcat();

    for (const svc of AUTOHEAL_SERVICES) {
      const key = svc.key;
      // WorkBuddy LAN 可选：config.json 里 workbuddyAutoStart=false 时自愈也不碰它
      if (key === 'workbuddy' && (!paths.workbuddyDir || !paths.workbuddyAutoStart)) continue;
      // NapCat 卡死看门狗：内存膨胀 / WebUI 连续无响应 → 自动重启（已处理则跳过常规自愈）
      if (key === 'napcat' && await maybeRestartHungNapcat()) continue;
      const port = autoHealPort(key);
      const st = autoHealEntry(key);
      // NapCat 未登录时只有 WebUI(6099) 在监听，WS(3001) 要扫码后才开。
      // 把「WebUI 可连」也算 up，否则自愈会把"等扫码"当成掉线，反复拉起并刷错误。
      let up = await probe(port);
      if (!up && key === 'napcat') up = await probe(paths.napcatWebuiPort);
      // WorkBuddy 的 TCP 端口可能还听着但 HTTP 已死（连接被重置）：必须用 /healthz 判断，
      // 否则自愈会以为它活着，永远不重启。
      if (key === 'workbuddy') up = (await probeWorkbuddy()).up;
      const decision = decideHeal({
        up,
        lastAttemptAt: st.lastAttemptAt,
        now: Date.now(),
        cooldownMs: AUTOHEAL_COOLDOWN_MS,
      });

      if (decision.reason === 'cooldown') {
        // 掉线但刚拉过：每个冷却窗口只提示一次，避免每 30s 刷一条
        if (st.lastSkipAt !== st.lastAttemptAt) {
          st.lastSkipAt = st.lastAttemptAt;
          pushLog('console', `自愈：${svc.label} 仍在冷却（剩余 ${Math.ceil(decision.waitMs / 1000)}s），本轮跳过`, 'warn');
        }
        continue;
      }
      if (decision.reason === 'up') {
        if ((st.failCount || 0) > 0 || st.lastResult === 'fail') {
          st.failCount = 0;
          st.lastAttemptAt = 0;
          st.lastResult = 'ok';
          delete lastServiceError[key];
          pushLog('console', `自愈：${svc.label} 已恢复（端口 ${port} 可连），失败计数清零`);
        }
        continue;
      }
      if (!decision.heal) continue;

      pushLog('console', `自愈：${svc.label} 掉线（端口 ${port} 无响应），自动拉起…`, 'warn');
      st.lastAttemptAt = Date.now();
      st.lastResult = 'pending';
      let ok = false;
      let error = '';
      try {
        ok = await autoHealStart(key);
      } catch (err) {
        error = err?.message || String(err);
      }
      // startXxx 内部已经 waitPort；这里再复探一次，防止「端口刚通又挂」。
      // NapCat 在等扫码时 3001 不会开，WebUI 6099 开着也算正常。
      if (ok && !(await probe(port))) ok = key === 'napcat' ? await probe(paths.napcatWebuiPort) : false;
      st.lastResult = ok ? 'ok' : 'fail';
      if (ok) {
        st.failCount = 0;
        pushLog('console', `自愈：${svc.label} 已恢复（端口 ${port} 可连）`);
      } else {
        st.failCount = (st.failCount || 0) + 1;
        let cooldownSec = AUTOHEAL_COOLDOWN_MS / 1000;
        let extra = '';
        if (st.failCount >= 3) {
          // 连续失败说明拉起手段已经无效（端口被卡死进程占着等）：拉长冷却，避免每 90s 刷三条错误。
          st.lastAttemptAt = Date.now() + AUTOHEAL_COOLDOWN_MS * 3;
          cooldownSec = Math.round(cooldownSec * 4);
          extra = `；已连续失败 ${st.failCount} 次，改为 ${cooldownSec}s 后再试，建议到服务卡片手动重启`;
        }
        pushLog('console', `自愈：${svc.label} 拉起失败（端口 ${port} 仍无响应${error ? `：${error}` : ''}），等冷却 ${cooldownSec}s 再试${extra}`, 'error');
      }
      await broadcastStatus();
    }
  } finally {
    autoHealRunning = false;
  }
}

/**
 * 启动自愈定时器：只在 server.listen 成功之后调用。
 * 用 setTimeout 链而不是 setInterval：拉起一个服务可能要 45~60s，
 * 绝不能让下一轮在上一轮还没结束时叠上来。
 */
function startAutoHealGuard() {
  if (autoHealTimer) return;
  const enabled = autoHealEnabled(paths.unified);
  autoHealEnabledLogged = enabled;
  if (enabled) pushLog('console', `自愈守护已启动（每 ${AUTOHEAL_INTERVAL_MS / 1000}s 检查一次）`);
  else pushLog('console', '自愈守护未启用（unifiedConsole.autoHeal=false）', 'warn');

  const loop = async () => {
    try { await autoHealTick(); }
    catch (err) { pushLog('console', `自愈：检查异常：${err?.message || err}`, 'error'); }
    autoHealTimer = setTimeout(loop, AUTOHEAL_INTERVAL_MS);
    autoHealTimer.unref?.(); // 不因为这个定时器拖住进程退出
  };
  autoHealTimer = setTimeout(loop, AUTOHEAL_INTERVAL_MS);
  autoHealTimer.unref?.();
}

// 日常采样：控制台在跑就每 5 分钟采一次（不依赖计划任务；控制台退出就暂停采样）。
let lifeLogTimer = null;
let lifeLogLastAt = 0;
function startLifeLogGuard() {
  if (lifeLogTimer) return;
  const loop = () => {
    try {
      const dir = path.join(STATE_DIR, 'life-log');
      if (fs.existsSync(path.join(dir, 'disabled'))) return; // 用户暂停
      if (Date.now() - lifeLogLastAt < 4.5 * 60_000) return;
      lifeLogLastAt = Date.now();
      execFile(process.execPath, [path.join(ROOT, 'scripts', 'life-log-sample.mjs')], { timeout: 20000, windowsHide: true }, (err) => {
        if (err) pushLog('console', `日常采样失败：${err.message}`, 'warn');
      });
    } catch (err) {
      pushLog('console', `日常采样异常：${err.message}`, 'warn');
    }
  };
  lifeLogTimer = setInterval(loop, 60_000);
  lifeLogTimer.unref?.();
  setTimeout(loop, 8000).unref?.();
  pushLog('console', '日常采样守护已启动（每 5 分钟一次；可在成长页暂停）');
}

// ---------------------------------------------------------------- 桥接 3100 代理

function readConsoleToken() {
  try { return fs.readFileSync(CONSOLE_TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

// 控制台可能比桥接先启动（首次开包、桥接崩了手动开控制台），此时 state/console-token
// 还不存在。这里按桥接同样的规则兜底生成一次并落盘，避免「控制台起来了但所有请求 401」。
let generatedConsoleToken = '';
function consoleTokenValue() {
  const configured = String(paths.cfg.consoleToken || '').trim();
  if (configured) return configured;
  const fromFile = readConsoleToken();
  if (fromFile) return fromFile;
  if (generatedConsoleToken) return generatedConsoleToken;
  generatedConsoleToken = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CONSOLE_TOKEN_FILE, generatedConsoleToken, { mode: 0o600 });
    pushLog('console', '控制台令牌未配置，已自动生成 state/console-token');
  } catch (err) {
    pushLog('console', `控制台令牌生成失败：${err?.message || err}`, 'warn');
  }
  return generatedConsoleToken;
}

/** 调 3100 的接口做「热生效」。桥接没起来时返回 {ok:false, offline:true} 而不是抛错。 */
async function callBridge(pathname, method = 'GET', body = null, timeout = 8000) {
  const token = consoleTokenValue();
  const url = `http://127.0.0.1:${paths.bridgePort}${pathname}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'x-console-token': token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 400) }; }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, offline: true, error: err.message };
  }
}

// ---------------------------------------------------------------- DSH settings / catalog

let catalogCache = { at: 0, data: null };

function dshClient() {
  return new NodeApiClient(paths.dshBase, undefined, {
    token: paths.cfg.dsh?.authToken || '',
    tokenExplicit: paths.cfg.dsh?.authTokenExplicit === true,
    header: paths.cfg.dsh?.authHeader,
    prefix: paths.cfg.dsh?.authPrefix,
    allowRemote: paths.cfg.dsh?.allowRemote === true,
  });
}

async function getModelCatalog({ force = false } = {}) {
  if (!force && catalogCache.data && Date.now() - catalogCache.at < 30_000) return catalogCache.data;
  const client = dshClient();
  const raw = await client.callUnary('session.modelCatalog', {});
  const value = unwrap(raw, 'session.modelCatalog');
  const providers = (value?.groups ?? []).map((g) => ({
    id: String(g.id),
    name: String(g.name || g.id),
    models: (g.models ?? []).map((m) => ({
      id: String(m.id),
      name: String(m.name || m.id),
      description: String(m.description || ''),
      defaultEffort: m.reasoning?.defaultEffort ?? null,
      efforts: (m.reasoning?.efforts ?? []).map((e) => ({ id: String(e.id), name: String(e.name || e.id) })),
    })),
  }));
  const data = {
    providers,
    default: value?.default ?? null,
    routableProviders: value?.routableProviders ?? [],
  };
  catalogCache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------- XD Pool / 路由链

const XDPOOL_ROUTE = '/plugins/dsh-xdpool';

/** XD Pool 插件的运行目录（插件用 DSH_HOME ?? homedir 拼 .xdpool）。 */
function xdpoolDir() {
  const home = process.env.DSH_HOME || os.homedir();
  const primary = path.join(home, '.xdpool');
  const legacy = path.join(os.homedir(), '.dsh', '.xdpool');
  if (fs.existsSync(primary)) return primary;
  return legacy;
}

function readJsonFileSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function dshBaseUrl() {
  return String(paths.cfg?.dsh?.baseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '');
}

/** 直接走 DSH 的插件 HTTP 路由（回环免 token），读一个区域的池状态。
 *  带缓存 + 后台刷新：global 区域首次要 20~30s，绝不能把页面请求堵在那里，先用旧值/占位返回。 */
const xdpoolStatusCache = new Map();
const xdpoolInflight = new Map();
async function xdpoolFetchNow(region) {
  const res = await fetch(`${dshBaseUrl()}${XDPOOL_ROUTE}/status?region=${region}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { ok: true, data: await res.json() };
}
function startXdpoolRefresh(region) {
  if (xdpoolInflight.has(region)) return;
  const job = (async () => {
    try {
      const value = await xdpoolFetchNow(region);
      xdpoolStatusCache.set(region, { at: Date.now(), value });
    } catch (err) {
      const prev = xdpoolStatusCache.get(region);
      xdpoolStatusCache.set(region, {
        at: Date.now() - 20_000, // 20 秒后再试，避免失败时疯狂重试
        value: prev?.value ?? { ok: false, error: String(err?.message ?? err) },
      });
    } finally { xdpoolInflight.delete(region); }
  })();
  xdpoolInflight.set(region, job);
}
async function fetchXdpoolStatus(region = 'cn', opts = {}) {
  const r = region === 'global' ? 'global' : 'cn';
  const ttl = Number(opts.ttl) || 30_000;
  const cached = xdpoolStatusCache.get(r);
  if (opts.force === true) {
    try {
      const value = await xdpoolFetchNow(r);
      xdpoolStatusCache.set(r, { at: Date.now(), value });
      return value;
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }
  if (cached && Date.now() - cached.at < ttl) return { ...cached.value, ageMs: Date.now() - cached.at };
  startXdpoolRefresh(r);
  if (cached) return { ...cached.value, stale: true, ageMs: Date.now() - cached.at };
  return { ok: false, pending: true, error: '首次读取中（国际版目录较慢，几秒后自动刷新）' };
}

async function postXdpoolRoute(routePath, body = {}) {
  try {
    const res = await fetch(`${dshBaseUrl()}${XDPOOL_ROUTE}${routePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 400) }; }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: String(err?.message ?? err) } };
  }
}

function summarizePool(result) {
  if (!result.ok) return { ok: false, error: result.error };
  const d = result.data || {};
  const accounts = (Array.isArray(d.accounts) ? d.accounts : []).map((a) => ({
    id: String(a.id ?? ''),
    label: String(a.label ?? a.id ?? ''),
    nickname: a.nickname ? String(a.nickname) : '',
    domain: String(a.domain ?? ''),
    cooling: a.cooling === true,
    dead: a.credentialDead === true,
    disabled: a.disabled === true,
    creditsTotal: typeof a.credits?.total === 'number' ? a.credits.total : null,
    expiresAt: a.expiresAt || '',
  }));
  const models = Array.isArray(d.models) ? d.models : [];
  return {
    ok: true,
    accounts,
    modelsTotal: models.length,
    modelsEnabled: models.filter((m) => m.enabled === true).length,
    catalogSource: d.catalogSource || '',
    activeAccountId: d.activeAccountId || '',
    distribution: d.distribution || '',
    shim: d.shim?.running ? d.shim.baseUrl : '',
  };
}

function xdpoolAggregatePath() { return path.join(xdpoolDir(), 'aggregate.json'); }

function readXdpoolAggregate() {
  const doc = readJsonFileSafe(xdpoolAggregatePath()) || {};
  const providers = doc.providers && typeof doc.providers === 'object' ? doc.providers : {};
  const combos = Array.isArray(doc.combos) ? doc.combos : [];
  const relay = doc.relay && typeof doc.relay === 'object' ? doc.relay : {};
  return { doc, providers, combos, relay };
}

function comboSlug(name) {
  const s = String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return s || 'combo';
}

/** 校验/归一化组合链（与插件的 normalizeCombos 保持同一形状）。 */
function normalizeComboList(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const name = String(item?.name ?? '').trim().slice(0, 40);
    if (!name) continue;
    const src = Array.isArray(item?.models) ? item.models : String(item?.models ?? '').split(/[\s,，]+/);
    const models = [...new Set(src.map((m) => String(m).trim()).filter((m) => m && !m.startsWith('combo:')))];
    if (!models.length) continue;
    let id = String(item?.id ?? '').trim();
    if (!id.startsWith('combo:')) id = `combo:${comboSlug(name)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      models,
      strategy: item?.strategy === 'round-robin' ? 'round-robin' : 'fallback',
      stickyLimit: Math.max(1, Math.min(10, Number(item?.stickyLimit) || 1)),
      enabled: item?.enabled !== false,
    });
  }
  return out;
}

function writeXdpoolCombos(combos) {
  const file = xdpoolAggregatePath();
  const doc = readJsonFileSafe(file) || { version: 1 };
  const clean = normalizeComboList(combos);
  doc.combos = clean;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return clean;
}

function chainRuntimeFile() { return path.join(ROOT, 'state', 'chain-runtime.json'); }

function readChainRuntime() {
  const d = readJsonFileSafe(chainRuntimeFile()) || {};
  return {
    activeIndex: Number.isInteger(d.activeIndex) && d.activeIndex >= 0 ? d.activeIndex : 0,
    switchedAt: Number(d.switchedAt) || 0,
    reason: String(d.reason || ''),
    switches: Array.isArray(d.switches) ? d.switches.slice(-20) : [],
  };
}

function writeChainRuntime(next) {
  try {
    fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
    fs.writeFileSync(chainRuntimeFile(), JSON.stringify(next, null, 2), 'utf8');
  } catch { /* best effort */ }
}

/** config.json 里的 dsh.chain：{ enabled, recoverMs, entries:[{provider,model,label}] }。 */
function chainConfig() {
  const raw = paths.cfg?.dsh?.chain;
  const entries = Array.isArray(raw?.entries)
    ? raw.entries
      .filter((e) => e && String(e.provider || '').trim() && String(e.model || '').trim())
      .map((e) => ({ provider: String(e.provider).trim(), model: String(e.model).trim(), label: String(e.label || '') }))
      .slice(0, 8)
    : [];
  return {
    enabled: raw?.enabled === true,
    recoverMs: Math.max(60_000, Number(raw?.recoverMs) || 900_000),
    entries,
  };
}

/** 模型能力矩阵（state/model-capabilities.json，由 state/agents/build-capabilities.mjs 汇总）。 */
function readModelCapabilities() {
  const file = path.join(ROOT, 'state', 'model-capabilities.json');
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, ...doc, mtime: fs.statSync(file).mtimeMs };
  } catch (err) {
    return { ok: false, message: String(err?.message ?? err), models: {}, stats: {}, generatedAt: '' };
  }
}

/** 按 provider/model 查能力；provider 为空时按 model 唯一匹配。 */
function capabilityOf(caps, provider, model) {
  if (!caps?.models) return null;
  const hit = caps.models[`${provider}/${model}`];
  if (hit) return hit;
  const same = Object.values(caps.models).filter((m) => m.model === model);
  return same.length === 1 ? same[0] : null;
}

/** 切模型：写 config.json + 桥接热生效 + DSH 默认（与 POST /api/model 同一套）。 */
async function applyRuntimeModel(provider, model, effort = '') {
  updateConfigFile((file) => {
    file.dsh = { ...(file.dsh ?? {}), provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
  });
  paths = runtimePaths();
  const hot = await callBridge('/api/dsh/model', 'POST', { provider, model, reasoningEffort: effort });
  let dshOk = false;
  let dshErr = '';
  try {
    await writeAgentDefaultModel({ provider, model, ...(effort ? { reasoningEffort: effort } : {}) });
    dshOk = true;
  } catch (err) { dshErr = String(err?.message ?? err); }
  catalogCache = { at: 0, data: null };
  // 换了 provider 就等于换了计费口径：清掉额度缓存并后台重算（池积分/桌面额度/订阅额度）。
  balanceCache = { at: 0, data: null };
  fetchBalance({ force: true }).catch(() => {});
  return { hot, dshOk, dshErr };
}

async function switchChainTo(index, reason) {
  const cfg = chainConfig();
  const entry = cfg.entries[index];
  if (!entry) throw new Error('路由链条目不存在');
  const r = await applyRuntimeModel(entry.provider, entry.model);
  const rt = readChainRuntime();
  const next = {
    activeIndex: index,
    switchedAt: Date.now(),
    reason,
    switches: [...rt.switches, { at: Date.now(), index, provider: entry.provider, model: entry.model, reason }].slice(-20),
  };
  writeChainRuntime(next);
  pushLog('console', `路由链：#${index + 1} ${entry.provider}/${entry.model} · ${reason}${r.hot.ok ? ' · 已热生效' : ''}`, index === 0 ? 'info' : 'warn');
  return { ...r, chain: next };
}

const CHAIN_FAIL_RE = /(429|500|502|503|504|11128|unapproved channel|请求被拦截|INVALID_REQUEST|DeepSeek Messages request failed|All chat models failed|APITimeoutError|rate[\s_-]?limit|too many requests|quota|积分|额度|余额不足|insufficient|upstream_connection_failed|upstream_timeout|connection failed|model_not_found|does not exist|unknown model|调用(?:WorkBuddy)?\s*失败|请求失败|超时|timed out)/i;
let chainLogCursor = { file: '', offset: 0 };
let chainBusy = false;

/** 增量读取桥接日志（只读新行，首次只记位置不判失败）。 */
function readNewBridgeLogLines() {
  const file = path.join(ROOT, 'state', 'bridge.log');
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  if (chainLogCursor.file !== file) {
    chainLogCursor = { file, offset: st.size };
    return [];
  }
  if (st.size < chainLogCursor.offset) chainLogCursor.offset = 0;
  if (st.size === chainLogCursor.offset) return [];
  const start = Math.max(chainLogCursor.offset, st.size - 200_000);
  const len = st.size - start;
  if (len <= 0) return [];
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, start);
    chainLogCursor.offset = st.size;
  } finally { fs.closeSync(fd); }
  return buf.toString('utf8').split(/\r?\n/).filter(Boolean);
}

/** 路由链巡检：主模型失败自动换池 → 冷却后回主模型。 */
async function chainTick() {
  const cfg = chainConfig();
  if (!cfg.enabled || cfg.entries.length < 2 || chainBusy) return;
  const rt = readChainRuntime();
  const cur = cfg.entries[Math.min(rt.activeIndex, cfg.entries.length - 1)];
  if (!cur) return;

  // 冷却结束 → 回主模型
  if (rt.activeIndex > 0 && rt.switchedAt && Date.now() - rt.switchedAt > cfg.recoverMs) {
    chainBusy = true;
    try { await switchChainTo(0, '冷却结束，恢复主模型'); }
    catch (err) { pushLog('console', `路由链恢复主模型失败：${err?.message ?? err}`, 'warn'); }
    finally { chainBusy = false; }
    return;
  }

  const lines = readNewBridgeLogLines();
  if (process.env.QQB_CHAIN_DEBUG) {
    try {
      fs.appendFileSync(path.join(ROOT, 'state', 'chain-debug.log'),
        `${new Date().toISOString()} tick lines=${lines.length} cur=${cur.provider}/${cur.model} idx=${rt.activeIndex} first=${String(lines[0] ?? '').slice(0, 160)}\n`);
    } catch { /* ignore */ }
  }
  if (!lines.length) return;
  const hit = lines.find((line) => CHAIN_FAIL_RE.test(line)
    && (line.includes(cur.model) || line.includes(cur.provider) || /model|provider/i.test(line))
    && !/路由链/.test(line));
  if (!hit) return;
  const recent = rt.switches.filter((s) => Date.now() - Number(s.at || 0) < 10 * 60_000);
  if (recent.length >= 5) return;
  if (rt.switchedAt && Date.now() - rt.switchedAt < 60_000) return;

  chainBusy = true;
  try {
    const nextIndex = (Math.min(rt.activeIndex, cfg.entries.length - 1) + 1) % cfg.entries.length;
    await switchChainTo(nextIndex, `失败自动切换：${String(hit).slice(0, 140)}`);
  } catch (err) {
    pushLog('console', `路由链切换失败：${err?.message ?? err}`, 'warn');
  } finally { chainBusy = false; }
}

async function readAgentDefaultModel() {
  const client = dshClient();
  const described = unwrap(await client.settings.describe({}), 'settings.describe');
  const ns = (described?.namespaces ?? []).find((n) => n.ns === 'agent-default-model');
  return { user: ns?.user ?? null, value: ns?.value ?? null };
}

async function writeAgentDefaultModel(patch) {
  const client = dshClient();
  const result = await client.settings.update({ ns: 'agent-default-model', patch });
  return unwrap(result, 'settings.update');
}

// ---------------------------------------------------------------- 余额

let balanceCache = { at: 0, data: null };

/** 从 ~/.dsh 的导入配置里读桌面端 provider（与自定义版控制台同一套逻辑）。 */
function readDshProvider() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const settingsFile = path.join(home, 'settings.yaml.imported');
  const credFile = path.join(home, '.credentials.yaml');
  if (!fs.existsSync(settingsFile)) return null;
  let settings = '';
  try { settings = fs.readFileSync(settingsFile, 'utf8'); } catch { return null; }
  const baseUrl = (/baseURL:\s*(\S+)/.exec(settings) || [])[1];
  if (!baseUrl) return null;
  const apiKeyEnv = (/apiKeyEnv:\s*(\S+)/.exec(settings) || [])[1];
  let apiKey = '';
  if (apiKeyEnv && fs.existsSync(credFile)) {
    try {
      const cred = fs.readFileSync(credFile, 'utf8');
      apiKey = (new RegExp(`${apiKeyEnv}\\s*:\\s*(\\S+)`).exec(cred) || [])[1] || '';
    } catch { /* 读不到就当没有 */ }
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, apiKeyEnv };
}

function balanceTarget() {
  const apiCfg = normalizeApiConfig(paths.cfg.api);
  if (apiCfg.apiKey) return { baseUrl: apiCfg.baseUrl, apiKey: apiCfg.apiKey, label: `直连 ${apiCfg.model}` };
  const dsh = readDshProvider();
  if (dsh?.apiKey) return { baseUrl: dsh.baseUrl, apiKey: dsh.apiKey, label: '桌面端 provider' };
  return null;
}

/** 当前实际在跑的模型来自哪个 provider：优先路由链生效项，其次 config.json 的 dsh.provider。 */
function currentRunProvider() {
  try {
    const dshCfg = paths.cfg?.dsh || {};
    const chain = dshCfg.chain && typeof dshCfg.chain === 'object' ? dshCfg.chain : null;
    if (chain?.enabled !== false && Array.isArray(chain?.entries) && chain.entries.length) {
      const rt = readChainRuntime();
      const idx = Number(rt?.activeIndex);
      const entry = Number.isInteger(idx) && idx >= 0 && idx < chain.entries.length ? chain.entries[idx] : chain.entries[0];
      if (entry?.provider) return { provider: String(entry.provider), model: String(entry.model || ''), via: 'chain' };
    }
    const provider = String(dshCfg.provider || '');
    if (provider) return { provider, model: String(dshCfg.model || ''), via: 'config' };
  } catch { /* 读不到就按直连 API 处理 */ }
  return null;
}

async function fetchBalance({ force = false } = {}) {
  if (!force && balanceCache.data && Date.now() - balanceCache.at < 60_000) return balanceCache.data;

  const run = currentRunProvider();
  const prov = run?.provider || '';

  // 1) XD Pool 池模型：额度和账号积分走插件状态接口，不是 API 余额
  if (prov === 'xdpool' || prov === 'xdpool-global') {
    const region = prov === 'xdpool-global' ? 'global' : 'cn';
    const poolLabel = `XD Pool ${region === 'cn' ? '国内版' : '国际版'}`;
    const raw = await fetchXdpoolStatus(region);
    const pool = raw?.ok ? summarizePool(raw) : null;
    if (!pool?.ok) {
      // 池状态是后台异步刷新的：读取中时保留上一次成功值，别把「读取中」当成余额不可用。
      const prev = balanceCache.data;
      if (prev?.ok && prev.kind === 'xdpool' && prev.region === region) {
        const kept = { ...prev, ts: Date.now(), stale: true, message: `${prev.message}（池状态刷新中，显示上次结果）` };
        balanceCache = { at: Date.now(), data: kept };
        return kept;
      }
      const data = {
        ok: false, pending: Boolean(raw?.pending), kind: 'xdpool', region,
        label: `${poolLabel} · ${run.model || ''}`.trim(),
        message: raw?.pending ? '池状态读取中（几秒后自动刷新）' : (raw?.error || '读不到池状态'),
        ts: Date.now(),
      };
      balanceCache = { at: Date.now(), data };
      return data;
    }
    const accounts = (pool.accounts || []).filter((a) => !a.dead && !a.disabled);
    const creditsOf = (a) => (typeof a.creditsTotal === 'number' ? a.creditsTotal : 0);
    const total = accounts.reduce((n, a) => n + creditsOf(a), 0);
    const cooling = accounts.filter((a) => a.cooling).length;
    const data = {
      ok: true, kind: 'xdpool', region,
      label: `${poolLabel} · ${accounts.length} 个账号`,
      display: `${total} 积分`,
      total, currency: '积分',
      infos: [{ currency: '积分', total: String(total), granted: '-', toppedUp: '-' }],
      accounts: accounts.map((a) => ({
        label: a.label || a.nickname || a.id, domain: a.domain, credits: a.creditsTotal, cooling: a.cooling,
      })),
      cooling,
      message: `可用积分 ${total}${cooling ? ` · ${cooling} 个账号冷却中` : ''}（模型 ${pool.modelsEnabled}/${pool.modelsTotal} 已启用）`,
      ts: Date.now(),
    };
    balanceCache = { at: Date.now(), data };
    return data;
  }

  // 2) WorkBuddy 网关：走桌面端登录账号的额度，不产生 API 计费
  if (prov === 'workbuddy') {
    const wb = await probeWorkbuddy(1500).catch(() => ({ up: false }));
    const data = {
      ok: true, kind: 'workbuddy',
      label: `WorkBuddy LAN（${run.model || '网关模型'}）`,
      display: '桌面账号额度',
      total: null, currency: '额度', infos: [],
      message: wb?.up ? '走桌面端登录账号的额度，不计 API 费用' : '网关未响应（健康检查失败）',
      ts: Date.now(),
    };
    balanceCache = { at: Date.now(), data };
    return data;
  }

  // 3) DSH 账号制 provider（deepseek-account 等）：订阅额度，没有公开余额接口
  if (/^deepseek-account$/.test(prov)) {
    const data = {
      ok: true, kind: 'account',
      label: `DeepSeek 账号（${run.model || '账号模型'}）`,
      display: '订阅额度',
      total: null, currency: '订阅', infos: [],
      message: 'DSH 账号登录（订阅制），没有 API 余额接口',
      ts: Date.now(),
    };
    balanceCache = { at: Date.now(), data };
    return data;
  }

  const target = balanceTarget();
  if (!target) {
    const data = { ok: false, message: '没有可用的 API Key（config.api 为空，桌面端凭据也没读到）', ts: Date.now() };
    balanceCache = { at: Date.now(), data };
    return data;
  }
  const { baseUrl, apiKey, label } = target;
  const root = baseUrl.replace(/\/v1$/, '');
  let url = '';
  if (/deepseek\.com/i.test(root)) url = `${root}/user/balance`;
  else if (/moonshot\.(cn|ai)/i.test(root)) url = `${root}/v1/users/me/balance`;
  else {
    const data = { ok: false, unsupported: true, message: `这个服务商没有公开的余额接口（${root}）`, label, ts: Date.now() };
    balanceCache = { at: Date.now(), data };
    return data;
  }

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await res.text();
    if (!res.ok) {
      let detail = raw.slice(0, 160);
      try { detail = JSON.parse(raw).error?.message || detail; } catch { /* 原文 */ }
      throw new Error(`HTTP ${res.status}：${detail}`);
    }
    const data = JSON.parse(raw);
    const infos = data.balance_infos || data.data?.balance_infos || [];
    const result = {
      ok: true,
      label,
      available: data.is_available ?? data.data?.is_available ?? null,
      infos: infos.map((b) => ({
        currency: b.currency || 'CNY',
        total: b.total_balance ?? b.available_balance ?? '0',
        granted: b.granted_balance ?? '0',
        toppedUp: b.topped_up_balance ?? '0',
      })),
      ts: Date.now(),
    };
    balanceCache = { at: Date.now(), data: result };
    return result;
  } catch (err) {
    const data = { ok: false, message: err.message, label, ts: Date.now() };
    balanceCache = { at: Date.now(), data };
    return data;
  }
}

// ---------------------------------------------------------------- NapCat（HTTP + WebUI）

let napcatInfoCache = { at: 0, data: null };
let napcatWebuiCache = { at: 0, credential: '' };

async function napcatOneBotInfo({ force = false } = {}) {
  if (!force && napcatInfoCache.data && Date.now() - napcatInfoCache.at < 6000) return napcatInfoCache.data;
  const out = { ok: false, uin: '', nick: '', error: '' };
  try {
    const res = await fetch(`http://127.0.0.1:${paths.napcatHttpPort}/get_login_info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json();
    if (data?.status === 'ok' && data.data) {
      out.ok = true;
      out.uin = String(data.data.user_id ?? '');
      out.nick = String(data.data.nickname ?? '');
    } else {
      out.error = data?.message || 'OneBot 返回异常';
    }
  } catch (err) {
    out.error = err.message;
  }
  napcatInfoCache = { at: Date.now(), data: out };
  return out;
}

function napcatWebuiConfigPath() {
  const candidates = [
    path.join(paths.napcatDir, 'napcat', 'config', 'webui.json'),
    path.join(paths.napcatDir, 'config', 'webui.json'),
  ];
  for (const file of candidates) if (fs.existsSync(file)) return file;
  return '';
}

function readNapcatWebuiToken() {
  const file = napcatWebuiConfigPath();
  if (!file) return { token: '', port: paths.napcatWebuiPort };
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const port = Number(cfg.port) || paths.napcatWebuiPort;
    return { token: String(cfg.token || ''), port, disabled: cfg.disableWebUI === true };
  } catch {
    return { token: '', port: paths.napcatWebuiPort };
  }
}

/** NapCat WebUI 用 SHA256(token + '.napcat') 换 Credential；缓存 10 分钟。 */
async function napcatWebuiLogin({ force = false } = {}) {
  const { token, port, disabled } = readNapcatWebuiToken();
  if (!token || disabled) return { ok: false, reason: '未找到 NapCat WebUI token（或已禁用 WebUI）', port };
  if (!force && napcatWebuiCache.credential && Date.now() - napcatWebuiCache.at < 10 * 60 * 1000) {
    return { ok: true, credential: napcatWebuiCache.credential, port };
  }
  const hash = crypto.createHash('sha256').update(`${token}.napcat`).digest('hex');
  // NapCat 刚启动时 WebUI 可能还没完全就绪，第一次 auth/login 常返回 Unauthorized；
  // 之前只试一次就放弃，导致「快速登录不可用（Unauthorized）」，只能人工扫码。
  // 这里重试 4 次（每次隔 1.5s），基本能覆盖 WebUI 的启动窗口。
  let lastReason = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
        signal: AbortSignal.timeout(6000),
      });
      const data = await res.json().catch(() => null);
      if (data?.code === 0 && data?.data?.Credential) {
        napcatWebuiCache = { at: Date.now(), credential: data.data.Credential };
        return { ok: true, credential: data.data.Credential, port };
      }
      lastReason = data?.message || `WebUI 登录失败（HTTP ${res.status}）`;
    } catch (err) {
      lastReason = `NapCat WebUI 不可达：${err.message}`;
    }
    if (attempt < 4) await sleep(1500);
  }
  return { ok: false, reason: lastReason, port };
}

async function napcatWebuiApi(apiPath, body = {}, { force = false } = {}) {
  let auth = await napcatWebuiLogin({ force });
  if (!auth.ok) return { ok: false, error: auth.reason, port: auth.port, webui: true };
  const call = async (credential) => {
    const res = await fetch(`http://127.0.0.1:${auth.port}${apiPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(8000),
    });
    return { status: res.status, data: await res.json() };
  };
  try {
    let { status, data } = await call(auth.credential);
    // NapCat 重启后旧 Credential 会失效（Unauthorized）：强制重新登录一次再试，
    // 避免控制台一直显示「登录态读取失败」直到 10 分钟凭据缓存过期。
    if (status === 401 || (data?.code !== 0 && /unauthor|未授权|登录失效/i.test(String(data?.message ?? '')))) {
      auth = await napcatWebuiLogin({ force: true });
      if (!auth.ok) return { ok: false, error: auth.reason, port: auth.port, webui: true };
      const retry = await call(auth.credential);
      data = retry.data;
    }
    if (data?.code !== 0) return { ok: false, error: data?.message || 'NapCat WebUI 返回异常', data, port: auth.port };
    return { ok: true, data: data.data, port: auth.port };
  } catch (err) {
    return { ok: false, error: err.message, port: auth.port };
  }
}

const napcatWebuiCache2 = { at: 0, data: null };

async function napcatStatus({ force = false } = {}) {
  if (!force && napcatWebuiCache2.data && Date.now() - napcatWebuiCache2.at < 10_000) return napcatWebuiCache2.data;
  const { token, port, disabled } = readNapcatWebuiToken();
  const base = {
    webui: {
      ok: Boolean(token) && !disabled,
      url: `http://127.0.0.1:${port}`,
      port,
      hasToken: Boolean(token),
      disabled: Boolean(disabled),
    },
    login: null,
    info: null,
    quickLogin: [],
    error: '',
  };
  const onebot = await napcatOneBotInfo({ force });
  base.onebot = onebot;

  if (token && !disabled) {
    const [status, info, quick] = await Promise.all([
      napcatWebuiApi('/api/QQLogin/CheckLoginStatus', {}, { force }),
      napcatWebuiApi('/api/QQLogin/GetQQLoginInfo', {}, { force }),
      napcatWebuiApi('/api/QQLogin/GetQuickLoginListNew', {}, { force }),
    ]);
    if (status.ok) base.login = status.data;
    if (info.ok) base.info = info.data;
    else if (onebot.ok) base.info = { uin: onebot.uin, nick: onebot.nick, online: true };
    if (quick.ok && Array.isArray(quick.data)) {
      base.quickLogin = quick.data.map((q) => ({ uin: String(q.uin ?? ''), nick: String(q.nickName ?? '') }));
    }
    if (!status.ok) base.error = status.error || '';
  }
  napcatWebuiCache2.at = Date.now();
  napcatWebuiCache2.data = base;
  return base;
}

// ---------------------------------------------------------------- token / 花费

let tokenCache = { at: 0, data: null };

/** 桥接在线 → 走 /api/tokens/*；离线 → 解析本地 jsonl（只算 token，不算钱）。 */
async function tokenSummary({ force = false } = {}) {
  if (!force && tokenCache.data && Date.now() - tokenCache.at < 20_000) return tokenCache.data;
  const live = await callBridge('/api/tokens/summary?limit=200', 'GET', null, 9000);
  if (live.ok && live.data?.ok) {
    const data = { ...live.data, source: 'bridge' };
    tokenCache = { at: Date.now(), data };
    return data;
  }
  const local = localTokenSummary();
  const data = { ...local, source: 'local', bridgeError: live.offline ? '桥接未运行' : (live.data?.error || '桥接返回异常') };
  tokenCache = { at: Date.now(), data };
  return data;
}

function readJsonl(file, limit = 20000) {
  const out = [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
  } catch { /* 文件不存在 */ }
  return out.length > limit ? out.slice(-limit) : out;
}

// ── 按功能分账（离线降级版）──────────────────────────────────────────────
//
// 桥接在线时用 `/api/tokens/summary` 里的 features（账本按 sessionId 归属）。
// 桥接离线时控制台只能自己解析 jsonl：逐轮记录里现在带 `f`（feature:level），
// 旧记录没有 f，就反查 state/sessions.json 的 parkedSessions / sessionVariants ——
// 这是桥接同一份映射，口径与在线一致（只是没有投影基线，只有逐轮明细）。
const FEATURE_LABELS = Object.freeze({
  chat: '聊天', sticker: '表情包', vision: '看图', voice: '语音', web: '联网', unknown: '未归属',
});

function localSessionFeatureMap() {
  const map = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'sessions.json'), 'utf8'));
    for (const [key, variant] of Object.entries(saved.sessionVariants || {})) {
      const sid = saved.sessions?.[key];
      if (sid && variant) map.set(String(sid), String(variant));
    }
    for (const parked of Object.values(saved.parkedSessions || {})) {
      for (const [variant, sid] of Object.entries(parked || {})) {
        if (sid && variant) map.set(String(sid), String(variant));
      }
    }
  } catch { /* 没有 sessions.json 就只能靠记录里的 f */ }
  return map;
}

function splitFeatureLevel(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { feature: 'unknown', level: 'unknown' };
  const idx = text.indexOf(':');
  if (idx < 0) return { feature: text.toLowerCase(), level: 'unknown' };
  const feature = text.slice(0, idx).toLowerCase() || 'unknown';
  const level = text.slice(idx + 1).toLowerCase();
  return { feature, level: level === 'basic' || level === 'advanced' ? level : 'unknown' };
}

/** 从逐轮记录聚合「按功能」视图；since>0 时只算窗口内（离线没有基线，不受影响）。 */
function localFeatureStats(entries, featureMap, since = 0) {
  const rows = new Map();
  const totals = {
    tokens: 0, turns: 0, steps: 0, cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0,
    levels: { basic: { tokens: 0, turns: 0 }, advanced: { tokens: 0, turns: 0 }, unknown: { tokens: 0, turns: 0 } },
  };
  const ensure = (feature) => {
    let row = rows.get(feature);
    if (!row) {
      row = {
        feature, label: FEATURE_LABELS[feature] || feature,
        tokens: 0, turns: 0, steps: 0, cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0,
        sessions: new Set(), models: new Set(),
        levels: { basic: { tokens: 0, turns: 0 }, advanced: { tokens: 0, turns: 0 }, unknown: { tokens: 0, turns: 0 } },
      };
      rows.set(feature, row);
    }
    return row;
  };
  for (const e of entries) {
    if (!e || e.k !== 'turn' || !e.b) continue;
    if (since > 0 && !(Number(e.t) >= since)) continue;
    const b = e.b;
    const tokens = (Number(b.cacheMiss) || 0) + (Number(b.cacheHit) || 0) + (Number(b.cacheWrite) || 0)
      + (Number(b.output) || 0) + (Number(b.reasoning) || 0);
    const { feature, level } = splitFeatureLevel(e.f || featureMap.get(String(e.sid || '')));
    const row = ensure(feature);
    row.tokens += tokens; row.turns += 1; row.steps += 1;
    row.cacheHit += Number(b.cacheHit) || 0;
    row.cacheMiss += Number(b.cacheMiss) || 0;
    row.cacheWrite += Number(b.cacheWrite) || 0;
    row.output += Number(b.output) || 0;
    if (e.sid) row.sessions.add(String(e.sid));
    if (e.model) row.models.add(String(e.model));
    row.levels[level].tokens += tokens;
    row.levels[level].turns += 1;

    totals.tokens += tokens; totals.turns += 1; totals.steps += 1;
    totals.cacheHit += Number(b.cacheHit) || 0;
    totals.cacheMiss += Number(b.cacheMiss) || 0;
    totals.cacheWrite += Number(b.cacheWrite) || 0;
    totals.output += Number(b.output) || 0;
    totals.levels[level].tokens += tokens;
    totals.levels[level].turns += 1;
  }
  // 固定出 5 个功能域（哪怕本期 0 用量），顺序与桥接一致；unknown 只在实际存在时出现。
  const FEATURE_ORDER = ['chat', 'sticker', 'vision', 'voice', 'web'];
  for (const feature of FEATURE_ORDER) ensure(feature);
  const grand = totals.tokens;
  const features = [...rows.values()].map((row) => {
    const input = row.cacheMiss + row.cacheHit + row.cacheWrite;
    return {
      feature: row.feature,
      label: row.label,
      totalTokens: row.tokens,
      share: null, // 下面按「五域内」重新归一；unknown 保持 null
      shareOfAll: grand > 0 ? row.tokens / grand : 0,
      cost: 0,
      cacheHitRate: input > 0 ? row.cacheHit / input : 0,
      turns: row.turns,
      steps: row.steps,
      sessions: row.sessions.size,
      models: [...row.models],
      buckets: { cacheMiss: row.cacheMiss, cacheHit: row.cacheHit, cacheWrite: row.cacheWrite, output: row.output, reasoning: 0 },
      levels: Object.fromEntries(Object.entries(row.levels).map(([level, v]) => [level, {
        totalTokens: v.tokens, turns: v.turns, buckets: {},
      }])),
    };
  });
  // 五域内占比（排除 unknown）。
  const attributedRows = features.filter((row) => row.feature !== 'unknown');
  const attributedTokens = attributedRows.reduce((sum, row) => sum + row.totalTokens, 0);
  for (const row of features) {
    if (row.feature !== 'unknown') row.share = attributedTokens > 0 ? row.totalTokens / attributedTokens : 0;
  }
  const rank = new Map(FEATURE_ORDER.map((feature, index) => [feature, index]));
  features.sort((a, b) => {
    const ra = rank.has(a.feature) ? rank.get(a.feature) : (a.feature === 'unknown' ? 9998 : 9999);
    const rb = rank.has(b.feature) ? rank.get(b.feature) : (b.feature === 'unknown' ? 9998 : 9999);
    if (ra !== rb) return ra - rb;
    return b.totalTokens - a.totalTokens;
  });
  const attributedLevels = {
    basic: { tokens: 0, turns: 0 }, advanced: { tokens: 0, turns: 0 }, unknown: { tokens: 0, turns: 0 },
  };
  let attributedCacheHit = 0;
  let attributedInput = 0;
  for (const row of attributedRows) {
    for (const [level, value] of Object.entries(row.levels)) {
      attributedLevels[level].tokens += value.totalTokens || 0;
      attributedLevels[level].turns += value.turns || 0;
    }
    attributedCacheHit += row.buckets.cacheHit;
    attributedInput += row.buckets.cacheMiss + row.buckets.cacheHit + row.buckets.cacheWrite;
  }
  const inputTotal = totals.cacheMiss + totals.cacheHit + totals.cacheWrite;
  return {
    features,
    attributed: {
      totalTokens: attributedTokens,
      cost: 0,
      turns: attributedRows.reduce((sum, row) => sum + row.turns, 0),
      steps: attributedRows.reduce((sum, row) => sum + row.steps, 0),
      inputTokens: attributedInput,
      outputTokens: attributedRows.reduce((sum, row) => sum + (row.buckets.output || 0), 0),
      cacheHitRate: attributedInput > 0 ? attributedCacheHit / attributedInput : 0,
      levels: attributedLevels,
    },
    totals: {
      totalTokens: totals.tokens,
      cost: 0,
      turns: totals.turns,
      steps: totals.steps,
      inputTokens: inputTotal,
      outputTokens: totals.output,
      cacheHitRate: inputTotal > 0 ? totals.cacheHit / inputTotal : 0,
      buckets: { cacheMiss: totals.cacheMiss, cacheHit: totals.cacheHit, cacheWrite: totals.cacheWrite, output: totals.output, reasoning: 0 },
      levels: Object.fromEntries(Object.entries(totals.levels).map(([level, v]) => [level, {
        totalTokens: v.tokens, turns: v.turns, cost: 0,
      }])),
    },
  };
}

function localTokenSummary() {
  const entries = readJsonl(TOKEN_LEDGER_FILE);
  const buckets = { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  const conversations = new Map();
  let turns = 0;
  let steps = 0;
  for (const e of entries) {
    if (e.k !== 'turn' || !e.b) continue;
    const b = e.b;
    for (const k of Object.keys(buckets)) buckets[k] += Number(b[k]) || 0;
    const key = String(e.key || 'unknown');
    const c = conversations.get(key) || {
      key, buckets: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      turns: 0, steps: 0, firstAt: e.t || 0, lastAt: 0, sessionIds: new Set(), models: new Set(),
    };
    for (const k of Object.keys(c.buckets)) c.buckets[k] += Number(b[k]) || 0;
    c.turns += 1;
    c.steps += 1;
    c.lastAt = Math.max(c.lastAt, e.t || 0);
    c.firstAt = Math.min(c.firstAt || e.t || 0, e.t || 0);
    if (e.sid) c.sessionIds.add(e.sid);
    if (e.model) c.models.add(e.model);
    conversations.set(key, c);
    turns += 1;
    steps += 1;
  }
  const totalTokens = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite + buckets.output + buckets.reasoning;
  // 按功能分账（离线口径：只有逐轮明细，没有投影基线；份额按有功能归属的用量归一）。
  const featureMap = localSessionFeatureMap();
  const allFeatures = localFeatureStats(entries, featureMap, 0);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayFeatures = localFeatureStats(entries, featureMap, todayStart.getTime());
  return {
    ok: true,
    generatedAt: Date.now(),
    currency: 'CNY',
    symbol: '¥',
    priceVersion: '',
    nowTier: null,
    features: allFeatures.features,
    featuresTotals: allFeatures.totals,
    featuresAttributed: allFeatures.attributed,
    featuresToday: todayFeatures.features,
    featuresTodayTotals: todayFeatures.totals,
    featuresTodayAttributed: todayFeatures.attributed,
    featuresSource: 'local',
    totals: {
      buckets,
      cost: 0,
      attributedCost: 0,
      unattributedCost: 0,
      byTier: {},
      turns,
      steps,
      conversations: conversations.size,
      estimated: true,
      totalTokens,
      inputTokens: buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite,
      cacheHitRate: (buckets.cacheHit + buckets.cacheMiss) > 0
        ? buckets.cacheHit / (buckets.cacheHit + buckets.cacheMiss) : 0,
      avgCostPerTurn: 0,
      avgCostPerStep: 0,
    },
    conversations: [...conversations.values()]
      .map((c) => ({
        key: c.key,
        sessionIds: [...c.sessionIds],
        sessions: c.sessionIds.size,
        buckets: c.buckets,
        cost: 0,
        turns: c.turns,
        steps: c.steps,
        firstAt: c.firstAt,
        lastAt: c.lastAt,
        models: [...c.models],
        estimated: true,
      }))
      .sort((a, b) => b.lastAt - a.lastAt),
    ledger: {
      file: TOKEN_LEDGER_FILE,
      journalLines: entries.length,
      maxLines: 20000,
      droppedLines: 0,
      sessions: new Set(entries.map((e) => e.sid).filter(Boolean)).size,
      baselines: 0,
      samples: entries.length,
      lastIngestAt: entries.length ? Math.max(...entries.map((e) => Number(e.t) || 0)) : 0,
      priceVersion: '',
      degraded: true,
    },
  };
}

async function tokenSeries({ hours = 24, buckets = 48 } = {}) {
  const live = await callBridge(`/api/tokens/series?hours=${hours}&buckets=${buckets}`, 'GET', null, 9000);
  if (live.ok && live.data?.ok) return { ...live.data, source: 'bridge' };
  // 离线回退：按小时聚合本地 jsonl（无价格 → 只给 token 数）
  const entries = readJsonl(TOKEN_LEDGER_FILE).filter((e) => e.k === 'turn' && e.t);
  const now = Date.now();
  const from = now - hours * 3600_000;
  const bucketMs = Math.max(60_000, Math.round((hours * 3600_000) / buckets));
  const map = new Map();
  for (let t = Math.floor(from / bucketMs) * bucketMs; t < now; t += bucketMs) {
    map.set(t, { t, cost: 0, tokens: 0, cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, turns: 0, steps: 0, keys: [] });
  }
  for (const e of entries) {
    if (e.t < from) continue;
    const b = e.b || {};
    const k = Math.floor(e.t / bucketMs) * bucketMs;
    const row = map.get(k);
    if (!row) continue;
    row.cacheMiss += Number(b.cacheMiss) || 0;
    row.cacheHit += Number(b.cacheHit) || 0;
    row.cacheWrite += Number(b.cacheWrite) || 0;
    row.output += Number(b.output) || 0;
    row.turns += 1;
    row.steps += 1;
    row.tokens = row.cacheMiss + row.cacheHit + row.cacheWrite + row.output;
    if (e.key && !row.keys.includes(e.key)) row.keys.push(e.key);
  }
  return {
    ok: true, source: 'local', generatedAt: now, currency: 'CNY', symbol: '¥',
    hours, bucketMs, from, to: now, buckets: [...map.values()], degraded: true,
  };
}

function readRecentTokens(limit = 50) {
  const entries = readJsonl(TOKEN_LEDGER_FILE).filter((e) => e.k === 'turn');
  return entries.slice(-limit).reverse().map((e) => {
    const b = e.b || {};
    return {
      time: e.t, key: e.key, sessionId: e.sid, turn: e.turn, step: e.step,
      model: e.model || null,
      tokens: (b.cacheMiss || 0) + (b.cacheHit || 0) + (b.cacheWrite || 0) + (b.output || 0) + (b.reasoning || 0),
      cacheMiss: b.cacheMiss || 0, cacheHit: b.cacheHit || 0, cacheWrite: b.cacheWrite || 0,
      output: b.output || 0, reasoning: b.reasoning || 0,
      cost: null, tier: null, estimated: true,
    };
  });
}

// ---------------------------------------------------------------- 人格

function listRoles() {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(ROLES_DIR, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
    const name = e.name.slice(0, -3);
    if (name === 'README') continue;
    const file = path.join(ROLES_DIR, e.name);
    let content = '';
    let st = { mtime: 0, size: 0 };
    try {
      content = fs.readFileSync(file, 'utf8');
      const s = fs.statSync(file);
      st = { mtime: s.mtimeMs, size: s.size };
    } catch { /* 读不到先跳过 */ }
    const lines = content.split(/\r?\n/);
    const firstLine = lines.find((l) => l.trim()) ?? '';
    out.push({
      name,
      size: content.length,
      bytes: st.size,
      mtime: st.mtime,
      lines: lines.length,
      nonEmptyLines: lines.filter((l) => l.trim()).length,
      preview: firstLine.slice(0, 80),
      heading: (/^#\s*(.+)$/m.exec(content) || [])[1]?.slice(0, 80) || '',
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function readRoleState() {
  try { return JSON.parse(fs.readFileSync(ROLE_STATE_FILE, 'utf8')); }
  catch { return { role: null, mode: 'active' }; }
}

function writeRoleState(role, mode) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(ROLE_STATE_FILE, JSON.stringify({ role: role ?? null, mode: mode ?? 'active' }), 'utf8');
}

function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

function roleFile(name) {
  const clean = sanitizeRoleName(name);
  if (!clean) return '';
  const file = path.join(ROLES_DIR, `${clean}.md`);
  // 双保险：确保结果仍在 roles/ 内
  if (!path.resolve(file).startsWith(path.resolve(ROLES_DIR) + path.sep)) return '';
  return file;
}

// ---------------------------------------------------------------- 会话

async function buildSessions() {
  const localState = (() => {
    try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return { sessions: {}, sessionPolicies: {} }; }
  })();
  const localSessions = localState.sessions && typeof localState.sessions === 'object' ? localState.sessions : {};
  const localPolicies = localState.sessionPolicies && typeof localState.sessionPolicies === 'object' ? localState.sessionPolicies : {};

  const [live, tokens, states, pending] = await Promise.all([
    callBridge('/api/sessions', 'GET', null, 6000),
    tokenSummary(),
    callBridge('/api/socialV2/states', 'GET', null, 6000),
    callBridge('/api/pending', 'GET', null, 5000),
  ]);

  const keys = new Map(); // key -> row
  const ensure = (key) => {
    const k = String(key || '');
    if (!keys.has(k)) {
      keys.set(k, {
        key: k, sessionId: '', owner: false, preset: null, mode: null,
        messages: 0, unread: 0, lastAt: 0, lastText: '', lastSender: '',
        cost: 0, tokens: 0, turns: 0, cacheHitRate: 0, models: [],
        wake: null, paused: false, source: 'local',
      });
    }
    return keys.get(k);
  };

  for (const [key, sessionId] of Object.entries(localSessions)) {
    const row = ensure(key);
    row.sessionId = String(sessionId || '');
  }
  for (const [key, raw] of Object.entries(localPolicies)) {
    const row = ensure(key);
    try {
      const parsed = JSON.parse(String(raw));
      if (Array.isArray(parsed)) { row.mode = parsed[0] ?? null; row.preset = parsed[1] ?? null; }
    } catch { /* 忽略 */ }
  }
  if (live.ok && Array.isArray(live.data?.sessions)) {
    for (const s of live.data.sessions) {
      const row = ensure(s.key);
      row.sessionId = String(s.sessionId || row.sessionId || '');
      row.owner = Boolean(s.owner);
      row.source = 'bridge';
    }
  }
  const liveStates = states.ok && Array.isArray(states.data?.conversations) ? states.data.conversations : [];
  for (const c of liveStates) {
    const row = ensure(c.key);
    row.unread = Number(c.unreadCount) || 0;
    row.messages = Number(c.recentCount) || row.messages;
    row.wake = c.wakeConfig
      ? {
        mode: c.wakeConfig.mode ?? null,
        infinite: c.wakeConfig.infinite ?? null,
        lastWakeAt: c.wakeConfig.lastWakeAt ?? 0,
        wakeCount: c.wakeConfig.wakeCount ?? 0,
        lastWakeReason: c.lastWakeReason ?? '',
      }
      : null;
    row.lastAiReplyAt = Number(c.lastAiReplyAt) || 0;
  }
  const convs = Array.isArray(tokens?.conversations) ? tokens.conversations : [];
  for (const c of convs) {
    const row = ensure(c.key);
    row.cost = Number(c.cost) || 0;
    row.turns = Number(c.turns) || 0;
    row.tokens = (c.buckets?.cacheMiss || 0) + (c.buckets?.cacheHit || 0) + (c.buckets?.cacheWrite || 0)
      + (c.buckets?.output || 0) + (c.buckets?.reasoning || 0);
    row.cacheHitRate = (c.buckets?.cacheHit || 0) + (c.buckets?.cacheMiss || 0) > 0
      ? (c.buckets.cacheHit || 0) / ((c.buckets.cacheHit || 0) + (c.buckets.cacheMiss || 0)) : 0;
    row.models = Array.isArray(c.models) ? c.models : [];
    row.lastAt = Math.max(row.lastAt, Number(c.lastAt) || 0);
  }

  // 只对最近的 N 个会话拉「最后一条消息」，避免几十个 key 打爆桥接
  const rows = [...keys.values()].filter((r) => r.key);
  rows.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  await Promise.all(rows.slice(0, 12).map(async (row) => {
    const r = await callBridge(`/api/socialV2/recent?key=${encodeURIComponent(row.key)}&limit=1`, 'GET', null, 5000);
    const msg = r.ok ? (r.data?.messages || [])[0] : null;
    if (msg) {
      row.lastAt = Math.max(row.lastAt, Number(msg.time) || 0);
      row.lastText = String(msg.tail ?? msg.text ?? '').slice(0, 120);
      row.lastSender = String(msg.sender ?? '');
    }
  }));

  const pendingList = pending.ok && Array.isArray(pending.data?.pending) ? pending.data.pending : [];
  for (const p of pendingList) {
    const row = ensure(p.key);
    row.pending = { kind: p.kind, toolName: p.toolName ?? '', reason: p.reason ?? '' };
  }

  const list = [...keys.values()].filter((r) => r.key)
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  return {
    ok: true,
    source: live.ok ? 'bridge' : 'local',
    bridgeError: live.offline ? '桥接未运行（只显示 state/sessions.json）' : (live.ok ? '' : (live.data?.error || '桥接返回异常')),
    sessions: list,
    pending: pendingList,
    stats: {
      total: list.length,
      unreadTotal: list.reduce((n, r) => n + (r.unread || 0), 0),
      costTotal: list.reduce((n, r) => n + (r.cost || 0), 0),
      tokensTotal: list.reduce((n, r) => n + (r.tokens || 0), 0),
      owner: list.filter((r) => r.owner).length,
    },
    ts: Date.now(),
  };
}

// ---------------------------------------------------------------- 备份 / 恢复

function backupMeta(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return null; }
}

function listBackups() {
  let entries = [];
  try { entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(BACKUPS_DIR, e.name);
    const meta = backupMeta(dir);
    const stat = fileStat(dir);
    out.push({
      name: e.name,
      path: dir,
      createdAt: meta?.createdAt || stat.mtime || 0,
      note: meta?.note || '',
      files: meta?.files ?? null,
      bytes: meta?.bytes ?? null,
      version: meta?.version || '',
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

const BACKUP_STATE_SKIP = /\.(log|lock)$|^console-token$|^workbuddy-env\.json$|\.bak-/i;
const BACKUP_SECRET_FIELD_RE = /^(agentToken|accessToken|authToken|apiKey|api_key|consoleToken|password|secret|token)$/i;

/** 备份里的密钥字段统一清空：备份是「可搬走的配置快照」，不应携带活令牌。 */
function redactBackupValue(value, depth = 0) {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => redactBackupValue(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (BACKUP_SECRET_FIELD_RE.test(k)) out[k] = '';
    else out[k] = redactBackupValue(v, depth + 1);
  }
  return out;
}

function createBackup(note = 'manual') {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const name = `${stampName()}${note ? `-${String(note).replace(/[^\w\u4e00-\u9fff-]/g, '').slice(0, 20)}` : ''}`;
  const dir = path.join(BACKUPS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const copied = [];
  const copyFile = (src, rel) => {
    try {
      const dst = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      const st = fs.statSync(dst);
      copied.push({ rel, size: st.size });
    } catch { /* 跳过读不到的文件 */ }
  };
  const copyJsonRedacted = (src, rel) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(src, 'utf8'));
      const dst = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, JSON.stringify(redactBackupValue(parsed), null, 2), 'utf8');
      const st = fs.statSync(dst);
      copied.push({ rel, size: st.size, redacted: true });
    } catch {
      // 解析失败就不复制，避免把未脱敏的原文带进备份。
      pushLog('console', `备份跳过无法脱敏的文件：${rel}`, 'warn');
    }
  };

  if (fs.existsSync(CONFIG_PATH)) copyJsonRedacted(CONFIG_PATH, 'config.json');
  if (fs.existsSync(CONFIG_EXAMPLE_PATH)) copyFile(CONFIG_EXAMPLE_PATH, 'config.example.json');

  let stateFiles = [];
  try { stateFiles = fs.readdirSync(STATE_DIR, { withFileTypes: true }); } catch { /* 无 state */ }
  for (const e of stateFiles) {
    if (!e.isFile()) continue;
    if (BACKUP_STATE_SKIP.test(e.name)) continue;
    const src = path.join(STATE_DIR, e.name);
    const st = fileStat(src);
    if (st.size > 8 * 1024 * 1024) continue; // 超大文件（异常膨胀）跳过
    // social-v2.json 里每个会话都带 agentToken；备份必须脱敏，否则等于把活令牌装进 zip。
    if (e.name === 'social-v2.json') {
      copyJsonRedacted(src, path.join('state', e.name));
      continue;
    }
    copyFile(src, path.join('state', e.name));
  }

  let roleFiles = [];
  try { roleFiles = fs.readdirSync(ROLES_DIR, { withFileTypes: true }); } catch { /* 无 roles */ }
  for (const e of roleFiles) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
    copyFile(path.join(ROLES_DIR, e.name), path.join('roles', e.name));
  }

  const bytes = copied.reduce((n, f) => n + f.size, 0);
  const meta = {
    name, createdAt: Date.now(), note, files: copied.length, bytes, version: CONSOLE_VERSION,
    secretsRedacted: copied.some((f) => f.redacted),
    entries: copied.map((f) => f.rel),
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  pushLog('console', `已备份 config + state + roles → backups/${name}（${copied.length} 个文件，${fmtBytes(bytes)}）`);
  return { ok: true, name, path: dir, files: copied.length, bytes, ts: Date.now() };
}

function safeBackupName(name) {
  const raw = String(name || '').trim();
  if (!/^[\w.\-\u4e00-\u9fff]+$/.test(raw)) return '';
  const dir = path.join(BACKUPS_DIR, raw);
  if (!path.resolve(dir).startsWith(path.resolve(BACKUPS_DIR) + path.sep)) return '';
  if (!fs.existsSync(dir)) return '';
  return dir;
}

function restoreBackup(name) {
  const dir = safeBackupName(name);
  if (!dir) return { ok: false, message: '备份不存在或名字不合法' };
  const meta = backupMeta(dir);
  const entries = Array.isArray(meta?.entries) ? meta.entries : [];
  if (!entries.length) return { ok: false, message: '这个备份里没有可恢复的文件（meta.json 缺失）' };
  // 恢复前先给当前状态再备份一份，避免恢复错了无法回头
  const pre = createBackup('pre-restore');
  // 不信任 meta.entries 里的路径/大小：逐文件 stat，超限直接跳过，
  // 避免被篡改的备份目录（或异常膨胀文件）在恢复时拖垮磁盘。
  const MAX_RESTORE_FILE_BYTES = 50 * 1024 * 1024;
  const MAX_RESTORE_TOTAL_BYTES = 512 * 1024 * 1024;
  let restored = 0;
  let restoredBytes = 0;
  for (const rel of entries) {
    const src = path.join(dir, rel);
    const dst = path.join(ROOT, rel);
    // 只允许恢复到根目录下的 config.json / state/* / roles/*
    const norm = path.normalize(rel);
    if (!/^(config\.json|config\.example\.json|state[\\/][^\\/]+|roles[\\/][^\\/]+\.md)$/i.test(norm)) continue;
    if (!path.resolve(dst).startsWith(path.resolve(ROOT) + path.sep)) continue;
    try {
      const st = fs.statSync(src);
      if (!st.isFile()) continue;
      if (st.size > MAX_RESTORE_FILE_BYTES) {
        pushLog('console', `恢复跳过超大文件 ${rel}（${fmtBytes(st.size)}）`, 'warn');
        continue;
      }
      if (restoredBytes + st.size > MAX_RESTORE_TOTAL_BYTES) {
        pushLog('console', `恢复已达到总大小上限 ${fmtBytes(MAX_RESTORE_TOTAL_BYTES)}，停止`, 'warn');
        break;
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      restoredBytes += st.size;
      restored += 1;
    } catch { /* 单个失败不影响其它 */ }
  }
  paths = runtimePaths();
  catalogCache = { at: 0, data: null };
  tokenCache = { at: 0, data: null };
  napcatWebuiCache2.at = 0;
  pushLog('console', `已从 backups/${name} 恢复 ${restored} 个文件（恢复前已自动备份为 ${pre.name}）`, 'warn');
  return { ok: true, restored, preBackup: pre.name, message: `已恢复 ${restored} 个文件；桥接/DSH 需要重启才能读到新配置` };
}

function deleteBackup(name) {
  const dir = safeBackupName(name);
  if (!dir) return { ok: false, message: '备份不存在' };
  fs.rmSync(dir, { recursive: true, force: true });
  pushLog('console', `已删除备份 backups/${name}`, 'warn');
  return { ok: true };
}

// ---------------------------------------------------------------- 设置

const SETTINGS_DEFAULTS = {
  theme: 'dark',
  pollMs: 4000,
  fontSize: 14,
  language: 'zh-CN',
  logLevel: 'all',
  logMaxLines: 800,
  logFollow: true,
  dense: false,
};

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return normalizeSettings(raw);
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const clamp = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const theme = ['dark', 'light'].includes(src.theme) ? src.theme : SETTINGS_DEFAULTS.theme;
  const language = ['zh-CN', 'zh-TW', 'en'].includes(src.language) ? src.language : 'zh-CN';
  const logLevel = ['all', 'debug', 'info', 'warn', 'error'].includes(src.logLevel) ? src.logLevel : 'all';
  return {
    theme,
    pollMs: clamp(src.pollMs, SETTINGS_DEFAULTS.pollMs, 2000, 60000),
    fontSize: clamp(src.fontSize, SETTINGS_DEFAULTS.fontSize, 12, 18),
    language,
    logLevel,
    logMaxLines: clamp(src.logMaxLines, SETTINGS_DEFAULTS.logMaxLines, 200, 5000),
    logFollow: src.logFollow !== false,
    dense: src.dense === true,
  };
}

function writeSettings(patch) {
  const next = normalizeSettings({ ...readSettings(), ...(patch || {}) });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ---------------------------------------------------------------- 密钥掩码（raw 配置编辑用）

const SECRET_FIELD_RE = /^(apiKey|authToken|consoleToken|accessToken|token|secret|password|totpSecret)$/i;

function maskSecrets(value, depth = 0) {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_FIELD_RE.test(k) && typeof v === 'string' && v.trim()) out[k] = '***';
    else out[k] = maskSecrets(v, depth + 1);
  }
  return out;
}

/** 把占位符 *** 还原成旧值：前端始终看不到真实密钥，保存时也不会把它抹掉。 */
function restoreSecrets(next, prev, depth = 0) {
  if (depth > 12) return next;
  if (Array.isArray(next) || Array.isArray(prev)) return next;
  if (!next || typeof next !== 'object') return next;
  for (const [k, v] of Object.entries(next)) {
    if (SECRET_FIELD_RE.test(k) && v === '***') {
      const old = prev && typeof prev === 'object' ? prev[k] : undefined;
      if (typeof old === 'string') next[k] = old;
      else delete next[k];
    } else if (v && typeof v === 'object' && prev && typeof prev === 'object' && prev[k]) {
      restoreSecrets(v, prev[k], depth + 1);
    }
  }
  return next;
}

// ---------------------------------------------------------------- 状态

let lastStatusJson = '';
let bridgeStatusCache = { at: 0, data: null };

async function bridgeLiveStatus() {
  if (bridgeStatusCache.data && Date.now() - bridgeStatusCache.at < 3000) return bridgeStatusCache.data;
  const r = await callBridge('/api/status', 'GET', null, 5000);
  const data = r.ok ? r.data : null;
  bridgeStatusCache = { at: Date.now(), data };
  return data;
}

function serviceProc(pid, procMap = null) {
  if (!pid) return null;
  const map = procMap || queryProcesses([pid]);
  const p = map[String(pid)];
  if (!p) return null;
  return {
    pid: Number(pid),
    name: p.name || '',
    mem: p.mem || 0,
    memText: p.mem ? fmtBytes(p.mem) : '-',
    cpu: p.cpu || 0,
    startedAt: p.startedAt || 0,
    uptimeMs: p.startedAt ? Math.max(0, Date.now() - p.startedAt) : 0,
    path: p.path || '',
  };
}

function lastErrFor(svc) {
  const e = lastServiceError[svc];
  return e ? { ts: e.ts, text: e.text.slice(0, 200) } : null;
}

async function buildStatus() {
  const ports = {
    napcat: paths.napcatWsPort,
    bridge: paths.bridgePort,
    dsh: paths.dshPort,
  };
  const [napcatWs, napcatHttp, napcatWebui, bridgeUp, dshUp, workbuddyHealth, workbuddyPortUp] = await Promise.all([
    probe(ports.napcat),
    probe(paths.napcatHttpPort),
    probe(paths.napcatWebuiPort),
    probe(ports.bridge),
    probe(ports.dsh),
    probeWorkbuddy(1200),
    probe(paths.workbuddyPort),
  ]);

  // 服务已恢复则清掉它上一次的错误，避免告警面板长期挂着旧失败（历史仍留在实时日志里）。
  if (napcatWs || napcatHttp || napcatWebui) delete lastServiceError.napcat;
  if (bridgeUp) delete lastServiceError.bridge;
  if (dshUp) delete lastServiceError.dsh;
  // healthz 有时还没起来（或探测超时），但端口/进程已经在听：也算恢复，别让「拉起失败」的旧告警一直挂着。
  if (workbuddyHealth?.up || workbuddyPortUp) delete lastServiceError.workbuddy;

  const { cfg, ok: cfgOk, error: cfgError } = readConfigSafe();
  if (!cfgOk) pushLogOnce(`config-parse:${cfgError}`, 'console', `config.json 解析失败：${cfgError}`, 'error');

  const pids = {
    napcat: pidForPort(ports.napcat),
    bridge: pidForPort(ports.bridge),
    dsh: pidForPort(ports.dsh),
    workbuddy: pidForPort(paths.workbuddyPort),
    console: String(process.pid),
  };
  // 一次 PowerShell 查询拿齐所有 PID 的名称/内存/启动时间，避免每个服务各跑一次
  const procMap = queryProcesses(Object.values(pids).filter(Boolean));
  const [bridgeInfo, napcat, tokens, balance, workbuddyModelIds] = await Promise.all([
    bridgeUp ? bridgeLiveStatus() : Promise.resolve(null),
    (napcatWs || napcatWebui) ? napcatStatus() : Promise.resolve(null),
    tokenSummary(),
    Promise.resolve(balanceCache.data),
    workbuddyHealth.up ? workbuddyModels() : Promise.resolve({ count: 0, ids: [] }),
  ]);

  // 模式以桥接运行时的为准：DSH 的 qq-mode 设置可能覆盖 state/mode.json
  let mode = (() => {
    try { return JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')).mode ?? ''; }
    catch { return ''; }
  })();
  if (bridgeInfo?.mode) mode = String(bridgeInfo.mode);

  const apiCfg = normalizeApiConfig(cfg.api);
  const allow = {
    private: ids(cfg.allow?.private),
    groups: ids(cfg.allow?.groups),
    denyPrivate: ids(cfg.deny?.private),
    denyGroups: ids(cfg.deny?.groups),
    ownerQQ: cfg.ownerQQ ? Number(cfg.ownerQQ) : null,
  };

  const svc = (pid, extra = {}) => {
    const p = serviceProc(pid, procMap);
    return {
      up: Boolean(extra.up),
      port: extra.port,
      pid: p?.pid ?? (pid ? Number(pid) : null),
      name: p?.name || '',
      mem: p?.mem ?? 0,
      memText: p?.memText ?? '-',
      cpu: p?.cpu ?? 0,
      startedAt: p?.startedAt ?? 0,
      uptimeMs: p?.uptimeMs ?? 0,
      path: p?.path || '',
      lastError: extra.svc ? lastErrFor(extra.svc) : null,
      ...extra.extra,
    };
  };

  const alarms = [];
  for (const s of ['napcat', 'bridge', 'dsh', 'workbuddy', 'console']) {
    const e = lastErrFor(s);
    if (e) alarms.push({ svc: s, ...e });
  }
  alarms.sort((a, b) => b.ts - a.ts);

  return {
    ts: Date.now(),
    version: CONSOLE_VERSION,
    console: {
      port: paths.port,
      pid: process.pid,
      uptimeMs: Date.now() - STARTED_AT,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      mem: process.memoryUsage().rss,
      memText: fmtBytes(process.memoryUsage().rss),
      root: ROOT,
      bridgePort: paths.bridgePort,
      dshBase: paths.dshBase,
      configOk: cfgOk,
      configError: cfgOk ? '' : cfgError,
      autoHeal: autoHealSnapshot(),
      admin: IS_ELEVATED,
    },
    services: {
      napcat: svc(pids.napcat, {
        up: napcatWs,
        port: ports.napcat,
        svc: 'napcat',
        extra: {
          httpPort: paths.napcatHttpPort,
          webuiPort: paths.napcatWebuiPort,
          httpUp: napcatHttp,
          webuiUp: napcatWebui,
          qq: paths.napcatQQ,
          mode: napcatMode(),
          // Docker 模式下 3001 的监听进程是 Docker 的转发器，显示容器名更有意义
          container: napcatMode() === 'docker' ? dockerContainerName() : '',
          ...(napcatMode() === 'docker' ? { name: 'docker', path: dockerComposePath() } : {}),
          wsConnected: Boolean(bridgeInfo?.snowluma?.connected),
          accountOnline: Boolean(bridgeInfo?.snowluma?.accountOnline),
          nickname: napcat?.info?.nick || napcat?.onebot?.nick || '',
          uin: napcat?.info?.uin || napcat?.onebot?.uin || paths.napcatQQ,
          loginPhase: napcat?.login?.loginPhase || '',
        },
      }),
      bridge: svc(pids.bridge, {
        up: bridgeUp,
        port: ports.bridge,
        svc: 'bridge',
        extra: {
          mode: bridgeInfo?.mode ?? mode,
          dshReady: Boolean(bridgeInfo?.dshReady),
          pending: Array.isArray(bridgeInfo?.pending) ? bridgeInfo.pending.length : 0,
          socialV2Paused: Boolean(bridgeInfo?.socialV2Paused),
          wsConnected: Boolean(bridgeInfo?.snowluma?.connected),
          accountOnline: Boolean(bridgeInfo?.snowluma?.accountOnline),
        },
      }),
      dsh: svc(pids.dsh, {
        up: dshUp,
        port: ports.dsh,
        svc: 'dsh',
        extra: { url: paths.dshBase },
      }),
      workbuddy: svc(pids.workbuddy, {
        up: workbuddyHealth.up,
        port: paths.workbuddyPort,
        svc: 'workbuddy',
        extra: {
          version: workbuddyHealth.version || '',
          apiBase: `http://127.0.0.1:${paths.workbuddyPort}/v1`,
        lanIp: lanIpv4(),
        lanIps: lanCandidates(),
        lanBaseUrl: lanIpv4() ? `http://${lanIpv4()}:${paths.workbuddyPort}/v1` : '',
          dataDir: paths.workbuddyDataDir,
          models: Array.isArray(workbuddyModelIds.ids) ? workbuddyModelIds.ids.length : 0,
          modelIds: Array.isArray(workbuddyModelIds.ids) ? workbuddyModelIds.ids.slice(0, 60) : [],
          // 网关在跑但读不到密钥（settings.json 缺 key_dpapi）时前端要把卡片标黄，而不是一片绿。
          hasKey: workbuddyHealth.up ? Boolean(workbuddyApiKey()) : null,
        },
      }),
      console: svc(pids.console, {
        up: true,
        port: paths.port,
        svc: 'console',
        extra: { uptimeMs: Date.now() - STARTED_AT, mem: process.memoryUsage().rss, memText: fmtBytes(process.memoryUsage().rss) },
      }),
    },
    model: {
      provider: cfg.dsh?.provider ?? '',
      model: cfg.dsh?.model ?? '',
      reasoningEffort: cfg.dsh?.reasoningEffort ?? '',
      ok: Boolean(cfg.dsh?.provider && cfg.dsh?.model),
    },
    api: {
      enabled: apiCfg.enabled,
      model: apiCfg.model,
      baseUrl: apiCfg.baseUrl,
      hasKey: Boolean(apiCfg.apiKey),
      groupTrigger: apiCfg.groupTrigger,
    },
    allow,
    mode,
    // 被踢标记：登录成功后清空；30 分钟内被踢过且尚未恢复 → UI 提示需要重新扫码
    napcatLogin: (() => {
      if (napcat?.login?.isLogin) napcatKickInfo = { at: 0, count: 0, text: '' };
      const kickedRecently = napcatKickInfo.at > 0 && Date.now() - napcatKickInfo.at < 30 * 60 * 1000;
      const base = napcat
        ? {
          ok: Boolean(napcat.login?.isLogin),
          online: Boolean(napcat.login?.isLogin) && !napcat.login?.isOffline,
          uin: String(napcat.info?.uin || napcat.onebot?.uin || ''),
          nick: String(napcat.info?.nick || napcat.onebot?.nick || ''),
          loginPhase: napcat.login?.loginPhase || '',
          coreReady: Boolean(napcat.login?.coreReady),
          error: napcat.error || napcat.login?.loginError || '',
        }
        : { ok: false, online: false, uin: paths.napcatQQ, nick: '', loginPhase: '', coreReady: false, error: napcatWs ? '读取登录状态失败' : 'NapCat 未运行' };
      const payload = {
        ...base,
        kicked: kickedRecently,
        kickedAt: napcatKickInfo.at,
        kickCount: napcatKickInfo.count,
        kickText: napcatKickInfo.text,
      };
      try { trackNapcatOnline(payload); } catch { /* 忽略 */ }
      return payload;
    })(),
    tokens: tokens
      ? {
        ok: true,
        source: tokens.source,
        cost: Number(tokens.totals?.cost) || 0,
        tokens: Number(tokens.totals?.totalTokens) || 0,
        turns: Number(tokens.totals?.turns) || 0,
        conversations: Number(tokens.totals?.conversations) || 0,
        cacheHitRate: Number(tokens.totals?.cacheHitRate) || 0,
        symbol: tokens.symbol || '¥',
      }
      : { ok: false },
    balance: balance
      ? (() => {
        // 换了 provider（切链/切模型）到额度重算完成之间，缓存里的口径是旧的：标 pending 让卡片说「刷新中」。
        const runP = currentRunProvider()?.provider || '';
        const expectedKind = runP === 'xdpool' || runP === 'xdpool-global' ? 'xdpool'
          : runP === 'workbuddy' ? 'workbuddy' : (/^deepseek-account$/.test(runP) ? 'account' : '');
        const balKind = balance.kind || '';
        const staleKind = Boolean(balKind && expectedKind && balKind !== expectedKind);
        return {
        ok: Boolean(balance.ok),
        message: balance.message || '',
        currency: balance.infos?.[0]?.currency || '',
        total: balance.infos?.[0]?.total ?? null,
        ts: balance.ts || 0,
        // 余额来源（"直连 deepseek-chat" / "桌面端 provider"）与「服务商没有公开余额接口」标记：
        // 前端卡片要显示来源，靠猜 api.model 会和真实取数渠道不一致。
        label: balance.label || '',
        unsupported: Boolean(balance.unsupported),
        // provider 相关额度：xdpool 池积分 / workbuddy 桌面额度 / deepseek-account 订阅额度
        kind: balance.kind || '',
        display: balance.display || '',
        pending: Boolean(balance.pending),
        cooling: Number(balance.cooling) || 0,
        poolAccounts: Array.isArray(balance.accounts) ? balance.accounts.length : 0,
        pending: Boolean(balance.pending) || staleKind,
        message: staleKind ? '已切换 provider，额度刷新中…' : (balance.message || ''),
      };
      })()
      : { ok: false, message: '点「刷新余额」拉取（按 config.api / 桌面端 provider 自动选择）' },
    alarms: alarms.slice(0, 8),
    counts: logCounts(),
  };
}

const loggedOnce = new Set();
function pushLogOnce(key, svc, text2, level) {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  pushLog(svc, text2, level);
}

async function broadcastStatus() {
  try {
    const status = await buildStatus();
    const raw = JSON.stringify(status);
    if (raw !== lastStatusJson) {
      lastStatusJson = raw;
      broadcast('status', status);
    }
  } catch { /* 状态算不出来就不推 */ }
}

// ---------------------------------------------------------------- 直连 API 帮助函数

async function apiListModels({ baseUrl, apiKey, timeoutMs = 15000 }) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(root)) return { ok: false, message: 'baseUrl 必须是 http(s) 地址' };
  if (!apiKey) return { ok: false, message: '没有 API Key（config.api.apiKey 为空）' };
  const started = Date.now();
  try {
    const res = await fetch(`${root}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* 非 JSON */ }
    const elapsed = Date.now() - started;
    if (!res.ok) {
      let detail = raw.slice(0, 200);
      try { detail = data?.error?.message || detail; } catch { /* 原文 */ }
      return { ok: false, status: res.status, elapsed, message: `HTTP ${res.status}：${detail}`, models: [] };
    }
    const models = Array.isArray(data?.data) ? data.data.map((m) => ({
      id: String(m.id ?? ''),
      ownedBy: String(m.owned_by ?? ''),
      created: Number(m.created) || 0,
    })) : [];
    return { ok: true, status: res.status, elapsed, models, count: models.length, baseUrl: root };
  } catch (err) {
    return { ok: false, elapsed: Date.now() - started, message: err.message, models: [] };
  }
}

// ---------------------------------------------------------------- 测试对话

async function testApiChat(message) {
  const cfg = normalizeApiConfig(paths.cfg.api);
  if (!cfg.apiKey) return { ok: false, message: 'config.api.apiKey 为空：先在「直连 api」页填 Key 并保存' };
  const reasoning = [];
  const client = new ApiChatClient({
    ...cfg,
    logger: {
      info: (line) => { pushLog('test', line); },
      warn: (line) => { pushLog('test', line, 'warn'); },
      error: (line) => { pushLog('test', line, 'error'); },
      debug: () => {},
    },
  });
  const started = Date.now();
  try {
    const reply = await client.chat([{ role: 'user', content: message }], {
      onReasoning: (t) => reasoning.push(t),
    });
    return {
      ok: true,
      reply,
      reasoning: reasoning.join('\n'),
      elapsed: Date.now() - started,
      backend: 'api',
      model: cfg.model,
      baseUrl: cfg.baseUrl,
    };
  } catch (err) {
    return { ok: false, message: err.message, backend: 'api', model: cfg.model };
  }
}

// ---------------------------------------------------------------- 诊断

function lockInfo() {
  const st = fileStat(LOCK_FILE);
  let pid = null;
  try { pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) || null; } catch { /* 无锁文件 */ }
  const alive = pid ? pidAlive(pid) : false;
  const listeningPid = pidForPort(paths.bridgePort);
  return {
    file: LOCK_FILE,
    exists: st.exists,
    mtime: st.mtime,
    pid,
    alive,
    listeningPid: listeningPid ? Number(listeningPid) : null,
    matches: Boolean(pid) && String(pid) === String(listeningPid || ''),
    staleHint: st.exists && !alive ? '锁里的进程已不在：可以删除 state/bridge.lock 后重启桥接' : '',
  };
}

function configChecks(cfg) {
  const checks = [];
  const push = (name, ok, level, detail) => checks.push({ name, ok, level, detail });
  push('config.json 可解析', true, 'ok', 'JSON 结构正常');
  push('DSH baseUrl', /^https?:\/\//i.test(String(cfg.dsh?.baseUrl || '')), 'warn',
    cfg.dsh?.baseUrl || '缺失（默认 http://127.0.0.1:3080）');
  push('DSH provider/model', Boolean(cfg.dsh?.provider && cfg.dsh?.model), 'warn',
    `${cfg.dsh?.provider || '?'}/${cfg.dsh?.model || '?'}`);
  const effortOk = !cfg.dsh?.reasoningEffort || REASONING_EFFORTS.includes(cfg.dsh.reasoningEffort);
  push('思考强度合法', effortOk, 'warn', cfg.dsh?.reasoningEffort || '（未设置）');
  const owner = Number(cfg.ownerQQ);
  push('ownerQQ', Number.isSafeInteger(owner) && owner > 0, 'warn', String(cfg.ownerQQ ?? '未设置'));
  const ownerInList = ids(cfg.allow?.private).includes(owner);
  push('owner 在 allow.private', ownerInList, 'info',
    ownerInList ? '是' : '否（owner 私聊会被白名单拦截，通常应加入）');
  push('allow.private 都是数字', ids(cfg.allow?.private).length === (Array.isArray(cfg.allow?.private) ? cfg.allow.private.length : 0), 'warn',
    `${ids(cfg.allow?.private).length} 个`);
  push('allow.groups 都是数字', ids(cfg.allow?.groups).length === (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups.length : 0), 'warn',
    `${ids(cfg.allow?.groups).length} 个`);
  const emptyAllow = !ids(cfg.allow?.private).length && !ids(cfg.allow?.groups).length;
  push('白名单非空', !emptyAllow, 'warn', emptyAllow ? '空：除非 allowAllWhenEmpty=true，否则没人能用' : '正常');
  push('consolePort', Number(cfg.consolePort) > 0, 'info', String(cfg.consolePort ?? '3100'));
  push('consoleToken', Boolean(cfg.consoleToken || readConsoleToken()), 'info',
    '已生成（state/console-token）');
  const apiCfg = normalizeApiConfig(cfg.api);
  push('直连 API Key', !apiCfg.enabled || Boolean(apiCfg.apiKey), 'warn',
    apiCfg.enabled ? `已启用，Key ${maskKey(apiCfg.apiKey)}` : '未启用');
  push('直连 baseUrl', /^https?:\/\//i.test(apiCfg.baseUrl), 'warn', apiCfg.baseUrl);
  const unified = cfg.unifiedConsole || {};
  push('控制台端口', Number(unified.port || 7788) === paths.port, 'info', `config=${unified.port ?? '(默认)'} 实际=${paths.port}`);
  push('NapCat 目录', fs.existsSync(String(unified.napcatDir || DEFAULT_NAPCAT_DIR)), 'warn',
    String(unified.napcatDir || DEFAULT_NAPCAT_DIR));
  return checks;
}

async function buildDiagnostics() {
  const { cfg, ok: cfgOk, error: cfgError } = readConfigSafe();
  const ports = [
    { port: paths.port, label: '统一控制台', key: 'console' },
    { port: paths.bridgePort, label: '合并版桥接', key: 'bridge' },
    { port: paths.dshPort, label: 'DSH Web', key: 'dsh' },
    { port: paths.napcatWsPort, label: 'NapCat WS (OneBot)', key: 'napcat-ws' },
    { port: paths.napcatHttpPort, label: 'NapCat HTTP (OneBot)', key: 'napcat-http' },
    { port: paths.napcatWebuiPort, label: 'NapCat WebUI', key: 'napcat-webui' },
  ];
  const portRows = await Promise.all(ports.map(async (p) => {
    const up = await probe(p.port);
    const pid = up ? pidForPort(p.port) : null;
    return { ...p, up, pid: pid ? Number(pid) : null };
  }));
  const diagPids = portRows.map((r) => r.pid).filter(Boolean);
  const diagProcMap = diagPids.length ? queryProcesses(diagPids) : {};
  for (const row of portRows) {
    const proc = row.pid ? serviceProc(row.pid, diagProcMap) : null;
    row.process = proc?.name || '';
    row.memText = proc?.memText || '';
    row.uptimeMs = proc?.uptimeMs || 0;
  }

  const lock = lockInfo();
  const checks = cfgOk ? configChecks(cfg) : [
    { name: 'config.json 可解析', ok: false, level: 'error', detail: cfgError },
  ];
  const files = [
    'config.json', 'config.example.json', 'state/sessions.json', 'state/mode.json',
    'state/current-role.json', 'state/social-v2.json', 'state/token-usage.jsonl',
    'state/stickers.json', 'state/slang.json', 'state/bridge.log', 'state/qq-activity.log',
    'state/tool-calls.jsonl', 'state/console-token', 'state/bridge.lock',
  ].map((rel) => {
    const st = fileStat(path.join(ROOT, rel));
    return { rel, ...st };
  });

  const tokenStats = tokenSummary ? await tokenSummary() : null;
  return {
    ok: true,
    ts: Date.now(),
    version: CONSOLE_VERSION,
    node: { version: process.version, pid: process.pid, uptimeMs: Date.now() - STARTED_AT, platform: process.platform, arch: process.arch },
    console: { port: paths.port, root: ROOT, bridgePort: paths.bridgePort, dshBase: paths.dshBase },
    ports: portRows,
    lock,
    config: {
      path: CONFIG_PATH,
      ok: cfgOk,
      error: cfgError,
      size: fileStat(CONFIG_PATH).size,
      mtime: fileStat(CONFIG_PATH).mtime,
      checks,
      topKeys: cfgOk ? Object.keys(cfg) : [],
    },
    files,
    backups: listBackups().slice(0, 10),
    tokenLedger: tokenStats?.ledger
      ? { ...tokenStats.ledger, source: tokenStats.source, totalTokens: tokenStats.totals?.totalTokens ?? 0, cost: tokenStats.totals?.cost ?? 0 }
      : null,
    roles: listRoles().length,
    logCounts: logCounts(),
  };
}

// ---------------------------------------------------------------- 路由

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${paths.port}`);
  const pathname = url.pathname;
  const dryRun = url.searchParams.get('dryRun') === '1';

  // Host 白名单（DNS rebinding 硬化）：只接受 127.0.0.1 / localhost / [::1] + 实际端口。
  // 反代/端口转发会被一并拒绝——要远程访问请用 SSH 隧道并自行承担。
  const boundPort = server.address()?.port ?? paths.port;
  if (!isAllowedLoopbackHost(req.headers.host, boundPort)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end('Host 头不被允许：控制台只接受本机回环访问');
    return;
  }

  // 统一 token 门禁：query（首次 /?token=）/ header（脚本）/ HttpOnly cookie（浏览器）。
  // 校验通过就续写 cookie，之后页面里的 fetch / SSE / img 都不用再手写 token。
  const expectedToken = consoleTokenValue();
  const authed = tokensMatch(tokenFromRequest(req, url), expectedToken);
  if (authed) res.setHeader('Set-Cookie', sessionCookie(expectedToken));
  const publicPath = pathname === '/api/health'
    || pathname === '/api/version'
    || pathname === '/favicon.ico'
    || pathname === '/apple-touch-icon.png'
    || pathname.startsWith('/vendor/');
  if (!publicPath && !authed) {
    if (pathname.startsWith('/api/')) {
      return json(res, 401, { ok: false, message: '未授权：请提供控制台访问令牌' });
    }
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', ...CONSOLE_SECURITY_HEADERS });
    res.end('<!doctype html><meta charset="utf-8"><title>需要控制台令牌</title>'
      + '<style>body{font:15px system-ui;margin:12vh auto;max-width:420px;color:#222}'
      + 'input{width:100%;padding:10px;margin:8px 0;box-sizing:border-box}'
      + 'button{padding:10px 18px}</style>'
      + '<h1>需要控制台令牌</h1><p>输入 <code>state/console-token</code> 里的值，或重启控制台查看启动日志。</p>'
      + '<form method="get" action="/"><input name="token" type="password" autofocus autocomplete="off" placeholder="控制台令牌"><button>进入</button></form>');
    return;
  }

  try {
    // 写操作统一要求 JSON：阻止任意网页用表单跨站触发启停/改配置
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { ok: false, message: '写接口必须使用 application/json' });
    }

    // ── 静态页 ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/ui')) {
      const html = fs.readFileSync(UI_PATH);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...CONSOLE_SECURITY_HEADERS });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && (pathname === '/favicon.ico' || pathname === '/apple-touch-icon.png')) {
      res.writeHead(204, { 'Cache-Control': 'max-age=86400' });
      res.end();
      return;
    }

    // ── 记忆银河（真星系底图 + 记忆点）──────────────────────────────────
    if (req.method === 'GET' && (pathname === '/memory-3d' || pathname === '/nebula')) {
      const nebulaFile = path.join(STATE_DIR, 'memory-3d.html');
      if (url.searchParams.get('refresh') === '1' || !fs.existsSync(nebulaFile)) {
        await new Promise((resolve) => {
          execFile(process.execPath, [path.join(ROOT, 'scripts', 'memory-3d.mjs')], { timeout: 40000, windowsHide: true }, () => resolve());
        });
        if (!fs.existsSync(nebulaFile)) return json(res, 500, { ok: false, message: '生成手绘星系失败' });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...CONSOLE_SECURITY_HEADERS });
      return res.end(fs.readFileSync(nebulaFile));
    }

    if (req.method === 'GET' && (pathname === '/memory-galaxy' || pathname === '/galaxy')) {
      const galaxyFile = path.join(STATE_DIR, 'memory-galaxy.html');
      const wantRefresh = url.searchParams.get('refresh') === '1';
      const regen = () => new Promise((resolve) => {
        execFile(process.execPath, [path.join(ROOT, 'scripts', 'memory-galaxy.mjs')], { timeout: 30000, windowsHide: true },
          (err, stdout) => resolve({ err, stdout }));
      });
      if (wantRefresh || !fs.existsSync(galaxyFile)) {
        const r = await regen();
        if (r.err || !fs.existsSync(galaxyFile)) {
          return json(res, 500, { ok: false, message: '生成记忆银河失败：' + String((r.err && r.err.message) || (r.stdout || '').slice(0, 300)) });
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...CONSOLE_SECURITY_HEADERS });
      return res.end(fs.readFileSync(galaxyFile));
    }

    // ── 控制台前端插件（离线 vendored，见 console/vendor/README.md）──────────
    if (req.method === 'GET' && pathname.startsWith('/vendor/')) {
      const rel = pathname.slice('/vendor/'.length);
      const vendorRoot = path.join(CONSOLE_DIR, 'vendor');
      const vendorPath = path.resolve(vendorRoot, rel);
      if (vendorPath !== vendorRoot && !vendorPath.startsWith(vendorRoot + path.sep)) {
        return json(res, 404, { ok: false, message: 'not found' });
      }
      const VENDOR_TYPES = {
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.svg': 'image/svg+xml; charset=utf-8',
        '.woff2': 'font/woff2',
      };
      const vendorExt = path.extname(vendorPath).toLowerCase();
      if (!VENDOR_TYPES[vendorExt] || !fs.existsSync(vendorPath) || !fs.statSync(vendorPath).isFile()) {
        return json(res, 404, { ok: false, message: 'not found' });
      }
      const vendorData = fs.readFileSync(vendorPath);
      res.writeHead(200, {
        'Content-Type': VENDOR_TYPES[vendorExt],
        'Content-Length': vendorData.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(vendorData);
    }

    // ── 跳转（token 已经换成 HttpOnly cookie，不再拼进 URL / 浏览器历史）──
    if (req.method === 'GET' && (pathname === '/go/bridge' || pathname === '/go/relay')) {
      const target = `http://127.0.0.1:${paths.bridgePort}/`;
      res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (req.method === 'GET' && pathname === '/go/dsh') {
      res.writeHead(302, { Location: paths.dshBase, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    // ── 基础 ───────────────────────────────────────────────────────────
    if (req.method === 'GET' && (pathname === '/api/health' || pathname === '/api/version')) {
      return json(res, 200, {
        ok: true, version: CONSOLE_VERSION, port: paths.port, pid: process.pid,
        uptimeMs: Date.now() - STARTED_AT, ts: Date.now(),
      });
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      return json(res, 200, await buildStatus());
    }

    // ── 日志 ───────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/logs') {
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Math.min(3000, Math.max(1, Number(url.searchParams.get('limit')) || 800));
      const svc = String(url.searchParams.get('svc') || 'all');
      const level = String(url.searchParams.get('level') || 'all');
      const q = String(url.searchParams.get('q') || '');
      return json(res, 200, {
        ok: true,
        logs: since ? recentLogs({ since, svc, level, q, limit }) : recentLogs({ svc, level, q, limit }),
        counts: logCounts(),
        seq: logSeq,
        ts: Date.now(),
      });
    }

    if (req.method === 'GET' && pathname === '/api/logs/export') {
      const svc = String(url.searchParams.get('svc') || 'all');
      const level = String(url.searchParams.get('level') || 'all');
      const q = String(url.searchParams.get('q') || '');
      const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit')) || 3000));
      const rows = recentLogs({ svc, level, q, limit });
      const header = [
        `# QQ Bridge 统一控制台日志导出`,
        `# 时间: ${new Date().toISOString()}`,
        `# 过滤: svc=${svc} level=${level} q=${q || '-'} 行数=${rows.length}`,
        '',
      ].join('\n');
      const body = header + rows.map((l) => {
        const d = new Date(l.ts);
        const t = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
          + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        return `${t} [${l.svc}] ${l.level.toUpperCase().padEnd(5)} ${l.text}`;
      }).join('\r\n');
      const filename = `qq-console-${stampName()}-${svc}-${level}.log`;
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/logs/clear') {
      const cleared = logs.length;
      logs.length = 0;
      lastStatusJson = '';
      for (const k of Object.keys(lastServiceError)) delete lastServiceError[k];
      pushLog('console', `日志已清空（${cleared} 条）`);
      return json(res, 200, { ok: true, cleared });
    }

    // ── SSE ────────────────────────────────────────────────────────────
    if (req.method === 'GET' && (pathname === '/api/stream' || pathname === '/api/logs/stream')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      res.write(`event: hello\ndata: ${JSON.stringify({ logs: logs.slice(-400), seq: logSeq, version: CONSOLE_VERSION })}\n\n`);
      buildStatus().then((s) => { try { res.write(`event: status\ndata: ${JSON.stringify(s)}\n\n`); } catch { /* 已断开 */ } });
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 25_000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    // ── 配置总览（Key 一律掩码）────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/config') {
      paths = runtimePaths(); // 外部（3100 控制台/手改）可能刚改过 config.json，这里重读
      const cfg = paths.cfg;
      const apiCfg = normalizeApiConfig(cfg.api);
      const roleState = readRoleState();
      return json(res, 200, {
        ok: true,
        ownerQQ: cfg.ownerQQ ?? null,
        allow: cfg.allow ?? { private: [], groups: [] },
        deny: cfg.deny ?? { private: [], groups: [] },
        dsh: {
          baseUrl: cfg.dsh?.baseUrl ?? '',
          provider: cfg.dsh?.provider ?? '',
          model: cfg.dsh?.model ?? '',
          reasoningEffort: cfg.dsh?.reasoningEffort ?? '',
        },
        api: {
          ...apiCfg,
          apiKey: '',
          apiKeyMasked: maskKey(apiCfg.apiKey),
          hasKey: Boolean(apiCfg.apiKey),
          defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
        },
        roles: listRoles(),
        roleState,
        modes: CONSOLE_MODES,
        reasoningEfforts: REASONING_EFFORTS,
        allowAllWhenEmpty: cfg.allowAllWhenEmpty === true,
        roleLimit: Number(cfg.role?.maxInjectChars) || 6000,
        unifiedConsole: {
          port: paths.port,
          configPort: Number(cfg.unifiedConsole?.port) || null,
          napcatDir: paths.napcatDir,
          napcatQQ: paths.napcatQQ,
          napcatWsPort: paths.napcatWsPort,
          napcatHttpPort: paths.napcatHttpPort,
          napcatWebuiPort: paths.napcatWebuiPort,
          dshExe: paths.dshExe,
          dshCli: paths.dshCli,
        },
        bridgePort: paths.bridgePort,
        dshBase: paths.dshBase,
        root: ROOT,
        settings: readSettings(),
        version: CONSOLE_VERSION,
        paths: {
          config: CONFIG_PATH,
          state: STATE_DIR,
          roles: ROLES_DIR,
          backups: BACKUPS_DIR,
          bridgeLog: BRIDGE_LOG,
          activityLog: ACTIVITY_LOG,
          tokenLedger: TOKEN_LEDGER_FILE,
        },
      });
    }

    // 原始配置（密钥掩码，保存时自动还原）
    if (req.method === 'GET' && pathname === '/api/config/raw') {
      const { cfg, ok, error } = readConfigSafe();
      if (!ok) return json(res, 200, { ok: false, message: error, raw: '', masked: true });
      return json(res, 200, {
        ok: true,
        raw: JSON.stringify(maskSecrets(cfg), null, 4),
        masked: true,
        note: '密钥字段显示为 ***，保存时会自动沿用原值，不会把真实 Key 写坏',
        size: fileStat(CONFIG_PATH).size,
        mtime: fileStat(CONFIG_PATH).mtime,
      });
    }

    if (req.method === 'POST' && pathname === '/api/config/raw') {
      const body = await readBody(req);
      const raw = String(body.raw ?? '');
      let parsed = null;
      try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); }
      catch (err) { return json(res, 400, { ok: false, message: `不是合法 JSON：${err.message}` }); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return json(res, 400, { ok: false, message: 'config.json 顶层必须是对象' });
      }
      const prev = readConfigSafe().cfg;
      restoreSecrets(parsed, prev);
      const backup = dryRun ? null : createBackup('pre-config-edit');
      if (!dryRun) {
        const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(parsed, null, 4), 'utf8');
        fs.renameSync(tmp, CONFIG_PATH);
      }
      paths = runtimePaths();
      catalogCache = { at: 0, data: null };
      tokenCache = { at: 0, data: null };
      pushLog('console', `config.json 已${dryRun ? '校验（dryRun）' : '保存'}（${Object.keys(parsed).length} 个顶层键）`, dryRun ? 'info' : 'warn');
      return json(res, 200, {
        ok: true, dryRun, keys: Object.keys(parsed), backup: backup?.name ?? null,
        message: dryRun ? 'JSON 合法（未写入）' : '已保存；桥接需要重启才能完整生效',
      });
    }

    // ── 启停 ───────────────────────────────────────────────────────────
    // 手动启停都包在 withLifecycle 里：自愈检测到 lifecycleDepth>0 会跳过本轮，
    // 不会和「一键启动全栈」抢同一个端口。
    if (req.method === 'POST' && pathname === '/api/start') return json(res, 200, await withLifecycle(startAll));
    if (req.method === 'POST' && pathname === '/api/stop') return json(res, 200, await withLifecycle(stopAll));
    if (req.method === 'POST' && pathname === '/api/restart') {
      return json(res, 200, await withLifecycle(async () => {
        await stopAll();
        await sleep(800);
        return startAll();
      }));
    }

    const svcMatch = /^\/api\/service\/(napcat|bridge|dsh|workbuddy)\/(start|stop|restart)$/.exec(pathname);
    if (req.method === 'POST' && svcMatch) {
      const [, name, action] = svcMatch;
      return json(res, 200, await withLifecycle(async () => {
        if (action === 'stop' || action === 'restart') await stopService(name);
        let ok = true;
        if (action === 'start' || action === 'restart') {
          ok = name === 'napcat' ? await startNapcat()
            : name === 'bridge' ? await startBridge()
              : name === 'workbuddy' ? await startWorkbuddy()
                : await startDsh();
        }
        await broadcastStatus();
        return { ok, message: `${name} ${action} ${ok ? '完成' : '失败（看日志）'}` };
      }));
    }

    // ── WorkBuddy LAN：模型实测结果（服务端持久化，刷新/换设备也能同步） ──
    if (req.method === 'GET' && pathname === '/api/workbuddy/test-results') {
      try {
        const raw = fs.readFileSync(WB_TEST_FILE, 'utf8');
        return json(res, 200, { ...JSON.parse(raw), source: 'file' });
      } catch {
        return json(res, 200, { ok: true, empty: true, results: {} });
      }
    }
    if (req.method === 'POST' && pathname === '/api/workbuddy/test-all') {
      if (dryRun) return json(res, 200, { ok: true, dryRun: true });
      const result = await runWorkbuddyModelTests();
      if (result.ok) {
        const okCount = Object.values(result.results).filter((r) => r.ok).length;
        pushLog('console', `WorkBuddy 模型测试完成：${okCount}/${result.count} 可用`, 'info');
      } else {
        pushLog('console', `WorkBuddy 模型测试失败：${result.message}`, 'warn');
      }
      return json(res, 200, result);
    }

    // ── WorkBuddy LAN：API 地址 + 密钥（仅本机可访问，控制台只监听 127.0.0.1） ──
    if (req.method === 'GET' && pathname === '/api/workbuddy/info') {
      const health = await probeWorkbuddy();
      const key = health.up ? workbuddyApiKey() : '';
      const models = health.up ? await workbuddyModels() : { count: 0, ids: [] };
      // 密钥只给「同源页面」或带正确 x-console-token 的调用方：
      // 本机其它网页 fetch 这个接口时会带自己的 Origin，不能让它把密钥读走。
      const origin = String(req.headers.origin || '');
      const referer = String(req.headers.referer || '');
      const tokenHdr = String(req.headers['x-console-token'] || '');
      const expectToken = consoleTokenValue();
      const sameOrigin = (u) => {
        try {
          const h = new URL(u).host;
          return h === `127.0.0.1:${paths.port}` || h === `localhost:${paths.port}`;
        } catch { return false; }
      };
      const trusted = Boolean(tokenHdr && expectToken && tokenHdr === expectToken)
        || (origin ? sameOrigin(origin) : (!referer || sameOrigin(referer)));
      if (!trusted) {
        return json(res, 403, {
          ok: false,
          hasKey: Boolean(key),
          message: '跨源读取被拒绝：API Key 只对控制台同源页面或带 x-console-token 的请求返回',
        });
      }
      return json(res, 200, {
        ok: health.up,
        version: health.version || '',
        port: paths.workbuddyPort,
        apiBase: `http://127.0.0.1:${paths.workbuddyPort}/v1`,
        lanIp: lanIpv4(),
        lanIps: lanCandidates(),
        lanBaseUrl: lanIpv4() ? `http://${lanIpv4()}:${paths.workbuddyPort}/v1` : '',
        hasKey: Boolean(key),
        apiKey: key,
        models: models.ids || [],
        dir: paths.workbuddyDir,
        dataDir: paths.workbuddyDataDir,
      });
    }

    // WorkBuddy LAN「连接测试」：走网关的 /v1/chat/completions，验证密钥与模型可用
    if (req.method === 'POST' && pathname === '/api/workbuddy/test') {
      const body = await readBody(req);
      const model = String(body?.model || 'default-model').trim() || 'default-model';
      const prompt = String(body?.prompt || '只回复四个字：连接成功').trim() || '只回复四个字：连接成功';
      if (!(await probeWorkbuddy()).up) return json(res, 200, { ok: false, message: 'WorkBuddy LAN 未运行，请先点「启动」' });
      const key = workbuddyApiKey();
      if (!key) return json(res, 200, { ok: false, message: '读取不到 API Key（%LOCALAPPDATA%\\WorkBuddyLAN\\settings.json）' });
      const startedAt = Date.now();
      try {
        const res2 = await fetch(`http://127.0.0.1:${paths.workbuddyPort}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 512 }),
          signal: AbortSignal.timeout(120_000),
        });
        const data = await res2.json().catch(() => null);
        const ms = Date.now() - startedAt;
        if (!res2.ok) {
          return json(res, 200, { ok: false, ms, model, message: data?.error?.message || `HTTP ${res2.status}` });
        }
        const reply = String(data?.choices?.[0]?.message?.content ?? '');
        return json(res, 200, {
          ok: true, ms, model: String(data?.model || model),
          reply: reply.slice(0, 4000),
          usage: data?.usage ?? null,
        });
      } catch (err) {
        return json(res, 200, { ok: false, ms: Date.now() - startedAt, model, message: err.message });
      }
    }

    // WorkBuddy LAN「放行内网端口」：调仓库自带 firewall.ps1（它会自己 UAC 提权）
    if (req.method === 'POST' && pathname === '/api/workbuddy/firewall') {
      const script = path.join(paths.workbuddyDir || '', 'firewall.ps1');
      const exe = path.join(paths.workbuddyDir || '', 'WorkBuddy-LAN.exe');
      if (!fs.existsSync(script)) return json(res, 200, { ok: false, message: `找不到 ${script}` });
      try {
        execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
          '-Port', String(paths.workbuddyPort), '-ProgramPath', exe], { timeout: 20_000, windowsHide: true });
        return json(res, 200, { ok: true, message: `已请求管理员权限放行 TCP ${paths.workbuddyPort}（请在 UAC 和完成提示里确认）` });
      } catch (err) {
        return json(res, 200, { ok: false, message: `放行失败：${err.message}` });
      }
    }

    // ── 模型：config.json + DSH agent-default-model ────────────────────
    if (req.method === 'GET' && pathname === '/api/model') {
      let catalog = null;
      let dshDefault = null;
      let dshError = '';
      try { catalog = await getModelCatalog(); } catch (err) { dshError = err.message; }
      try { dshDefault = await readAgentDefaultModel(); } catch (err) { dshError = dshError || err.message; }
      return json(res, 200, { ok: true, config: maskSecrets(paths.cfg.dsh ?? {}), catalog, dshDefault, dshError, efforts: REASONING_EFFORTS });
    }

    // ── NapCat 掉线历史 ──
    if (req.method === 'GET' && pathname === '/api/napcat/offline-history') {
      return json(res, 200, { ok: true, events: napcatEvents.slice().reverse(), summary: napcatHistorySummary() });
    }

    // ── 语音（TTS）配置与测试 ──
    if (pathname === '/api/voice') {
      const VOICE_DEFAULTS = { enabled: true, dir: 'audio', maxSeconds: 300, maxBytes: 20971520, maxPerMinute: 2, maxPerHour: 10 };
      if (req.method === 'GET') {
        const v = { ...VOICE_DEFAULTS, ...(paths.cfg?.socialV2?.voice || {}) };
        return json(res, 200, { ok: true, voice: v, sendVoiceTool: paths.cfg?.socialV2?.tools?.sendVoice !== false });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const raw = body && typeof body.voice === 'object' && body.voice ? body.voice : {};
        const clean = {};
        if (raw.enabled !== undefined) clean.enabled = Boolean(raw.enabled);
        for (const k of ['maxSeconds', 'maxBytes', 'maxPerMinute', 'maxPerHour']) {
          if (raw[k] === undefined) continue;
          const n = Number(raw[k]);
          if (!Number.isFinite(n) || n < 0) return json(res, 400, { ok: false, message: `${k} 必须是非负数` });
          clean[k] = Math.round(n);
        }
        if (dryRun) return json(res, 200, { ok: true, dryRun: true, voice: clean });
        updateConfigFile((file) => {
          file.socialV2 = { ...(file.socialV2 ?? {}), voice: { ...(file.socialV2?.voice ?? {}), ...clean } };
          if (clean.enabled !== undefined) {
            file.socialV2.tools = { ...(file.socialV2.tools ?? {}), sendVoice: clean.enabled !== false };
          }
        });
        paths = runtimePaths();
        const hot = await callBridge('/api/dsh/voice', 'POST', { voice: clean });
        pushLog('console', `语音配置已更新：${JSON.stringify(clean).slice(0, 160)}`, 'info');
        return json(res, 200, { ok: true, voice: clean, bridge: hot.ok ? '已热生效' : (hot.offline ? '桥接未运行（重启后生效）' : (hot.data?.error || '桥接返回异常')) });
      }
    }
    if (req.method === 'POST' && pathname === '/api/voice/test') {
      const body = await readBody(req);
      const text = String(body?.text ?? '').trim().slice(0, 200);
      const r = await callBridge('/api/voice/test', 'POST', { text }, 190000);
      if (r.ok && r.data?.ok) return json(res, 200, r.data);
      return json(res, 502, { ok: false, message: r.data?.error || r.data?.message || (r.offline ? '桥接未运行' : '语音测试失败') });
    }

    // ── 使用说明（读取 docs/操控台详细说明.md） ──
    if (req.method === 'GET' && pathname === '/api/help') {
      try {
        const docsDir = path.join(ROOT, 'docs');
        let file = path.join(docsDir, '操控台详细说明.md');
        if (!fs.existsSync(file)) {
          const cand = fs.existsSync(docsDir) ? fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')) : [];
          if (!cand.length) return json(res, 404, { ok: false, message: 'docs/ 下没有说明文件' });
          file = path.join(docsDir, cand[0]);
        }
        const md = fs.readFileSync(file, 'utf8');
        const st = fs.statSync(file);
        return json(res, 200, { ok: true, md, file, updatedAt: st.mtimeMs });
      } catch (error) {
        return json(res, 500, { ok: false, message: String(error?.message ?? error) });
      }
    }

    // ── 干净关通道（代理桥接 /api/socialV2/channel）：关掉后不再自动唤醒，消息仍入库 ──
    if (req.method === 'POST' && pathname === '/api/socialV2/channel') {
      const body = await readBody(req);
      const key = String(body.key ?? '').trim();
      if (!key) return json(res, 400, { ok: false, error: 'key 不能为空' });
      const r = await callBridge('/api/socialV2/channel', 'POST', { key, enabled: body.enabled !== false });
      if (r.ok && r.data) {
        pushLog('console', `通道${r.data.enabled === false ? '静音' : '恢复'}：${key}`);
        return json(res, 200, r.data);
      }
      return json(res, r.offline ? 503 : 400, {
        ok: false,
        offline: Boolean(r.offline),
        error: r.data?.error || (r.offline ? '桥接未运行' : '桥接返回异常'),
      });
    }

    // ── 运行参数（WorkBuddy 优化项，热更新） ──
    // ── 手动触发一次「主动机会」（控制台调试用，代理桥接 /api/socialV2/wake） ──
    if (req.method === 'POST' && pathname === '/api/socialV2/wake-now') {
      const body = await readBody(req);
      const key = String(body.key ?? '').trim();
      const reason = String(body.reason ?? 'proactiveCheck').trim() || 'proactiveCheck';
      if (!key) return json(res, 400, { ok: false, error: 'key 不能为空' });
      const r = await callBridge('/api/socialV2/wake', 'POST', { key, reason });
      if (r.ok && r.data && r.data.ok) return json(res, 200, r.data);
      return json(res, r.offline ? 503 : 400, {
        ok: false,
        offline: Boolean(r.offline),
        error: r.data?.error || (r.offline ? '桥接未运行' : '桥接返回异常'),
      });
    }

    if (pathname === '/api/tuning') {
      const TUNING_DEFAULTS = {
        preSleepMs: 15000, waitMaxMs: 60000, groupRotateTokens: 45000, workbuddyRotateTokens: 80000,
        snapshotCharScale: 0.4, groupSnapshotScale: 0.75, interruptMinAgeMs: 15000,
        autoInterrupt: true, autoFallback: true, groupAnyMessage: false, advancedTriggers: [],
      };
      const PROACTIVE_DEFAULTS = {
        enabled: true, checkIntervalMinMs: 30 * 60 * 1000, checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000, probability: 0.3,
        privateIdleThresholdMs: 30 * 60 * 1000, privateProbability: 0.35, skipWorkbuddy: false,
      };
      const proactiveNow = () => ({ ...PROACTIVE_DEFAULTS, ...(paths.cfg?.socialV2?.proactive || {}) });
      if (req.method === 'GET') {
        const t = { ...TUNING_DEFAULTS, ...(paths.cfg?.socialV2?.tuning || {}) };
        return json(res, 200, { ok: true, tuning: t, proactive: proactiveNow() });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const t = body && typeof body.tuning === 'object' && body.tuning ? body.tuning : {};
        const clean = {};
        for (const k of ['preSleepMs', 'waitMaxMs', 'groupRotateTokens', 'workbuddyRotateTokens', 'snapshotCharScale', 'groupSnapshotScale', 'interruptMinAgeMs']) {
          if (t[k] === undefined) continue;
          const n = Number(t[k]);
          // 轮换阈值允许 0 = 不限制；其它参数必须为正数
          const allowZero = k === 'groupRotateTokens' || k === 'workbuddyRotateTokens';
          if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) {
            return json(res, 400, { ok: false, message: allowZero ? `${k} 不能为负数（0 = 不限制）` : `${k} 必须是正数` });
          }
          clean[k] = n;
        }
        for (const k of ['autoInterrupt', 'autoFallback', 'groupAnyMessage']) {
          if (t[k] !== undefined) clean[k] = Boolean(t[k]);
        }
        if (t.advancedTriggers !== undefined) {
          const arr = Array.isArray(t.advancedTriggers) ? t.advancedTriggers : String(t.advancedTriggers).split(/[,，\s]+/);
          clean.advancedTriggers = arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 100);
        }
        // 主动机会（自动冒泡）：enabled/probability 类走 0..1，阈值类走毫秒。
        const cleanProactive = {};
        if (body && typeof body.proactive === 'object' && body.proactive) {
          const p = body.proactive;
          for (const k of ['enabled', 'skipWorkbuddy']) {
            if (p[k] !== undefined) cleanProactive[k] = Boolean(p[k]);
          }
          for (const k of ['probability', 'privateProbability']) {
            if (p[k] === undefined) continue;
            const n = Number(p[k]);
            if (!Number.isFinite(n) || n < 0 || n > 1) return json(res, 400, { ok: false, message: `${k} 必须在 0~1 之间` });
            cleanProactive[k] = n;
          }
          for (const k of ['idleThresholdMs', 'privateIdleThresholdMs', 'checkIntervalMinMs', 'checkIntervalMaxMs']) {
            if (p[k] === undefined) continue;
            const n = Math.round(Number(p[k]));
            if (!Number.isFinite(n) || n < 60 * 1000 || n > 24 * 60 * 60 * 1000) {
              return json(res, 400, { ok: false, message: `${k} 必须在 1 分钟 ~ 24 小时之间` });
            }
            cleanProactive[k] = n;
          }
        }
        if (dryRun) return json(res, 200, { ok: true, dryRun: true, tuning: clean, proactive: cleanProactive });
        updateConfigFile((file) => {
          file.socialV2 = {
            ...(file.socialV2 ?? {}),
            tuning: { ...(file.socialV2?.tuning ?? {}), ...clean },
            proactive: { ...(file.socialV2?.proactive ?? {}), ...cleanProactive },
          };
        });
        paths = runtimePaths();
        // 沉睡观察秒数也同步到 DSH preset 提示词（DSH 重启后完全生效；桥接侧闸门已立即生效）
        if (clean.preSleepMs) {
          try {
            const presetFile = path.join(os.homedir(), '.dsh', 'plugins', 'qq-agent-presets', 'presets', 'qq-chat-v2.patch.yml');
            if (fs.existsSync(presetFile)) {
              let y = fs.readFileSync(presetFile, 'utf8');
              const sec = Math.round(Number(clean.preSleepMs) / 1000);
              y = y.replace(/qq_wait_for_messages\(timeoutMs=\d+\) 完成沉睡前观察（默认 \d+ 秒/, `qq_wait_for_messages(timeoutMs=${clean.preSleepMs}) 完成沉睡前观察（默认 ${sec} 秒`);
              fs.writeFileSync(presetFile, y, 'utf8');
            }
          } catch { /* best effort */ }
        }
        const hot = await callBridge('/api/dsh/tuning', 'POST', { tuning: clean });
        let proactiveHot = null;
        if (Object.keys(cleanProactive).length > 0) {
          const r = await callBridge('/api/socialV2/config', 'POST', { proactive: cleanProactive });
          proactiveHot = r.ok ? '已热生效' : (r.offline ? '桥接未运行（重启后生效）' : (r.data?.error || '桥接返回异常'));
        }
        pushLog('console', `运行参数已更新：${JSON.stringify({ ...clean, ...cleanProactive }).slice(0, 160)}`, 'info');
        return json(res, 200, {
          ok: true,
          tuning: { ...TUNING_DEFAULTS, ...(paths.cfg?.socialV2?.tuning || {}) },
          proactive: proactiveNow(),
          bridge: hot.ok ? '已热生效' : (hot.offline ? '桥接未运行（重启后生效）' : (hot.data?.error || '桥接返回异常')),
          proactiveBridge: proactiveHot,
        });
      }
    }

    // ── 最近路由决策（控制台展示用，代理桥接） ──
    if (req.method === 'GET' && pathname === '/api/model/routes') {
      const live = await callBridge('/api/dsh/routes', 'GET', null, 6000);
      if (live.ok && live.data?.ok) return json(res, 200, { ...live.data, source: 'bridge' });
      return json(res, 200, { ok: false, offline: true, message: '桥接未运行', mode: paths.cfg?.dsh?.routing?.mode || 'auto', decisions: [] });
    }

    // ── 模型能力矩阵（工具调用 / 看图，实测结果） ──────────────────────
    if (req.method === 'GET' && pathname === '/api/model/capabilities') {
      return json(res, 200, readModelCapabilities());
    }

    // ── XD Pool：账号池快照 + 路由链（主模型失败自动换池） ──────────────
    if (req.method === 'GET' && pathname === '/api/xdpool') {
      const force = new URL(req.url, 'http://127.0.0.1').searchParams.get('force') === '1';
      const [cn, global] = await Promise.all([fetchXdpoolStatus('cn', { force }), fetchXdpoolStatus('global', { force })]);
      const agg = readXdpoolAggregate();
      const rt = readChainRuntime();
      const chain = chainConfig();
      let providers = [];
      try { providers = (await getModelCatalog()).providers; } catch { /* DSH 离线 */ }
      const activeIndex = chain.entries.length ? Math.min(rt.activeIndex, chain.entries.length - 1) : 0;
      return json(res, 200, {
        ok: true,
        home: xdpoolDir(),
        cn: summarizePool(cn),
        global: summarizePool(global),
        aggregate: {
          providers: Object.entries(agg.providers).map(([id, v]) => ({ id, enabled: v?.enabled === true, baseUrl: v?.baseUrl || '' })),
          combos: normalizeComboList(agg.combos),
          relay: { enabled: agg.relay?.enabled === true },
        },
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          models: p.models.map((m) => ({ id: m.id, name: m.name, efforts: m.efforts.map((e) => e.id) })),
        })),
        chain: {
          enabled: chain.enabled,
          recoverMs: chain.recoverMs,
          entries: chain.entries,
          activeIndex,
          activeProvider: chain.entries[activeIndex]?.provider || '',
          activeModel: chain.entries[activeIndex]?.model || '',
          switchedAt: rt.switchedAt,
          reason: rt.reason,
          history: rt.switches,
        },
        current: { provider: paths.cfg?.dsh?.provider || '', model: paths.cfg?.dsh?.model || '' },
      });
    }

    if (req.method === 'POST' && pathname === '/api/xdpool/chain') {
      const body = await readBody(req);
      const rawEntries = Array.isArray(body.entries) ? body.entries : [];
      const entries = rawEntries
        .map((e) => ({ provider: String(e?.provider ?? '').trim(), model: String(e?.model ?? '').trim(), label: String(e?.label ?? '').trim() }))
        .filter((e) => e.provider && e.model)
        .slice(0, 8);
      if (!entries.length) return json(res, 400, { ok: false, message: '路由链至少要有一条 provider/model' });
      const enabled = body.enabled !== false;
      const recoverMs = Math.max(60_000, Math.min(24 * 3_600_000, Number(body.recoverMs) || 900_000));
      const caps = readModelCapabilities();
      const warnings = entries
        .map((e, i) => {
          const cap = capabilityOf(caps, e.provider, e.model);
          if (!cap || cap.tools !== false) return null;
          return `#${i + 1} ${e.provider}/${e.model} 不支持工具调用${cap.note ? `（${cap.note}）` : ''} —— QQ 机器人切到它会哑`;
        })
        .filter(Boolean);
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, enabled, recoverMs, entries, warnings });
      updateConfigFile((file) => {
        file.dsh = { ...(file.dsh ?? {}), chain: { enabled, recoverMs, entries } };
      });
      paths = runtimePaths();
      const rt = readChainRuntime();
      if (rt.activeIndex >= entries.length) writeChainRuntime({ ...rt, activeIndex: 0, switchedAt: 0, reason: '' });
      pushLog('console', `路由链已保存：${enabled ? '自动切换开' : '只记录不自动切'} · ${entries.map((e) => `${e.provider}/${e.model}`).join(' → ')}`, 'info');
      return json(res, 200, { ok: true, enabled, recoverMs, entries, warnings });
    }

    if (req.method === 'POST' && pathname === '/api/xdpool/chain/switch') {
      const body = await readBody(req);
      const cfg = chainConfig();
      if (!cfg.entries.length) return json(res, 400, { ok: false, message: '还没有配置路由链' });
      let index = Number(body.index);
      if (!Number.isInteger(index) || index < 0 || index >= cfg.entries.length) {
        const rt = readChainRuntime();
        index = (Math.min(rt.activeIndex, cfg.entries.length - 1) + 1) % cfg.entries.length;
      }
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, index });
      try {
        const r = await switchChainTo(index, String(body.reason || '手动切换'));
        return json(res, 200, {
          ok: true,
          index,
          entry: cfg.entries[index],
          bridge: r.hot.ok ? '已热生效' : (r.hot.offline ? '桥接未运行（重启后生效）' : (r.hot.data?.error || '桥接返回异常')),
          dshDefault: r.dshOk ? '已同步' : (r.dshErr || '未同步'),
          chain: r.chain,
        });
      } catch (err) {
        return json(res, 500, { ok: false, message: String(err?.message ?? err) });
      }
    }

    if (req.method === 'POST' && pathname === '/api/xdpool/combos') {
      const body = await readBody(req);
      const combos = Array.isArray(body.combos) ? body.combos : [];
      try {
        const saved = writeXdpoolCombos(combos);
        pushLog('console', `XD Pool 组合链已保存 ${saved.length} 条（${saved.map((c) => c.name).join('、') || '空'}）`, 'info');
        return json(res, 200, { ok: true, combos: saved, file: xdpoolAggregatePath() });
      } catch (err) {
        return json(res, 500, { ok: false, message: String(err?.message ?? err) });
      }
    }

    if (req.method === 'POST' && pathname === '/api/xdpool/refresh') {
      const notes = [];
      for (const region of ['cn', 'global']) {
        const r = await postXdpoolRoute('/models/refresh', { region });
        notes.push(`${region} 模型目录：${r.ok ? '已刷新' : `失败（${r.data?.error || r.status}）`}`);
      }
      const rescan = await postXdpoolRoute('/accounts/rescan', {});
      notes.push(`账号重扫：${rescan.ok ? `发现 ${rescan.data?.accounts ?? '?'} 个` : `失败（${rescan.data?.error || rescan.status}）`}`);
      catalogCache = { at: 0, data: null };
      xdpoolStatusCache.clear();
      pushLog('console', `XD Pool 刷新：${notes.join('；')}`, 'info');
      return json(res, 200, { ok: true, notes });
    }

    // ── 进阶模型（自由选择 provider/model）：写 config.json + 桥接热生效 ──
    if (req.method === 'POST' && pathname === '/api/model/advanced') {
      const body = await readBody(req);
      const provider = String(body.provider ?? '').trim();
      const model = String(body.model ?? '').trim();
      const effort = String(body.reasoningEffort ?? '').trim();
      if (!provider || !model) return json(res, 400, { ok: false, message: 'provider 和 model 都不能为空' });
      if (effort && !REASONING_EFFORTS.includes(effort)) return json(res, 400, { ok: false, message: `reasoningEffort 只能是 ${REASONING_EFFORTS.join(' / ')}` });
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, provider, model, reasoningEffort: effort });
      updateConfigFile((file) => {
        file.dsh = {
          ...(file.dsh ?? {}),
          advanced: {
            ...(file.dsh?.advanced ?? {}),
            enabled: true, provider, model,
            ...(effort ? { reasoningEffort: effort } : {}),
          },
        };
      });
      paths = runtimePaths();
      const hot = await callBridge('/api/dsh/advanced', 'POST', { provider, model, reasoningEffort: effort });
      pushLog('console', `进阶模型：${provider}/${model}${effort ? `（${effort}）` : ''}`, 'info');
      return json(res, 200, {
        ok: true, provider, model, reasoningEffort: effort,
        bridge: hot.ok ? '已热生效' : (hot.offline ? '桥接未运行（重启后生效）' : (hot.data?.error || '桥接返回异常')),
      });
    }

    // ── 模型路由模式（auto / basic / advanced）：写 config.json 并让桥接立即生效 ──
    if (req.method === 'POST' && pathname === '/api/model/routing') {
      const body = await readBody(req);
      const mode = String(body.mode ?? '').trim();
      if (!['auto', 'basic', 'advanced'].includes(mode)) {
        return json(res, 400, { ok: false, message: 'mode 只能是 auto / basic / advanced' });
      }
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, mode });
      updateConfigFile((file) => {
        file.dsh = { ...(file.dsh ?? {}), routing: { ...(file.dsh?.routing ?? {}), mode } };
      });
      paths = runtimePaths();
      const hot = await callBridge('/api/dsh/routing', 'POST', { mode });
      const label = mode === 'auto' ? '自动（按内容）' : (mode === 'basic' ? '强制基础模型' : '强制进阶模型');
      pushLog('console', `模型路由：${label}`, 'info');
      return json(res, 200, {
        ok: true, mode,
        bridge: hot.ok ? '已热生效' : (hot.offline ? '桥接未运行（重启后生效）' : (hot.data?.error || '桥接返回异常')),
      });
    }

    if (req.method === 'POST' && pathname === '/api/model') {
      const body = await readBody(req);
      const provider = String(body.provider ?? '').trim();
      const model = String(body.model ?? '').trim();
      if (!provider || !model) return json(res, 400, { ok: false, message: 'provider 和 model 都不能为空' });
      const effort = String(body.reasoningEffort ?? '').trim();
      if (effort && !REASONING_EFFORTS.includes(effort)) {
        return json(res, 400, { ok: false, message: `reasoningEffort 只能是 ${REASONING_EFFORTS.join(' / ')}` });
      }
      if (dryRun) {
        return json(res, 200, { ok: true, dryRun: true, provider, model, reasoningEffort: effort, steps: [] });
      }
      updateConfigFile((file) => {
        file.dsh = { ...(file.dsh ?? {}), provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
      });
      paths = runtimePaths();
      const result = { ok: true, provider, model, reasoningEffort: effort, steps: [] };

      // 1) 桥接热生效（不用重启）
      const hot = await callBridge('/api/dsh/model', 'POST', { provider, model, reasoningEffort: effort });
      result.steps.push({
        name: '桥接热生效',
        ok: hot.ok,
        detail: hot.offline ? '桥接未运行（下次启动时按 config.json 生效）' : (hot.data?.error ?? '已应用到现有会话'),
      });

      // 2) DSH 全局默认模型（新会话默认值）
      if (body.syncDshDefault !== false) {
        try {
          await writeAgentDefaultModel({ provider, model, ...(effort ? { reasoningEffort: effort } : {}) });
          result.steps.push({ name: 'DSH agent-default-model', ok: true, detail: '已写入' });
        } catch (err) {
          result.steps.push({ name: 'DSH agent-default-model', ok: false, detail: err.message });
        }
      }
      catalogCache = { at: 0, data: null };
      pushLog('console', `模型已设为 ${provider}/${model}${effort ? `（${effort}）` : ''}`);
      await broadcastStatus();
      return json(res, 200, result);
    }

    // ── 允许的人 / owner / deny ────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/whitelist') {
      const cfg = paths.cfg;
      return json(res, 200, {
        ok: true,
        ownerQQ: cfg.ownerQQ ?? null,
        allow: { private: ids(cfg.allow?.private), groups: ids(cfg.allow?.groups) },
        deny: { private: ids(cfg.deny?.private), groups: ids(cfg.deny?.groups) },
        allowAllWhenEmpty: cfg.allowAllWhenEmpty === true,
        counts: {
          private: ids(cfg.allow?.private).length,
          groups: ids(cfg.allow?.groups).length,
          denyPrivate: ids(cfg.deny?.private).length,
          denyGroups: ids(cfg.deny?.groups).length,
        },
      });
    }

    if (req.method === 'POST' && (pathname === '/api/whitelist' || pathname === '/api/allow')) {
      const body = await readBody(req);
      const allowPrivate = toIdList(body.allowPrivate);
      const allowGroups = toIdList(body.allowGroups);
      const denyPrivate = toIdList(body.denyPrivate);
      const denyGroups = toIdList(body.denyGroups);
      let ownerQQ;
      if (body.ownerQQ !== undefined) {
        const raw = String(body.ownerQQ ?? '').trim();
        if (raw === '') ownerQQ = null;
        else if (!/^\d+$/.test(raw) || Number(raw) <= 0) return json(res, 400, { ok: false, message: 'ownerQQ 必须是 QQ 号（正整数）' });
        else ownerQQ = Number(raw);
      }
      if (dryRun) {
        return json(res, 200, {
          ok: true, dryRun: true,
          allow: { private: allowPrivate ?? [], groups: allowGroups ?? [] },
          deny: { private: denyPrivate ?? [], groups: denyGroups ?? [] },
          ownerQQ: ownerQQ ?? null,
          message: '校验通过（未写入）',
        });
      }

      updateConfigFile((file) => {
        if (allowPrivate || allowGroups) {
          file.allow = {
            private: allowPrivate ?? file.allow?.private ?? [],
            groups: allowGroups ?? file.allow?.groups ?? [],
          };
        }
        if (denyPrivate || denyGroups) {
          file.deny = {
            private: denyPrivate ?? file.deny?.private ?? [],
            groups: denyGroups ?? file.deny?.groups ?? [],
          };
        }
        if (ownerQQ !== undefined) file.ownerQQ = ownerQQ;
        if (typeof body.allowAllWhenEmpty === 'boolean') file.allowAllWhenEmpty = body.allowAllWhenEmpty;
      });
      paths = runtimePaths();

      const cfg = paths.cfg;
      const hot = await callBridge('/api/whitelist', 'POST', {
        allow: cfg.allow ?? { private: [], groups: [] },
        deny: cfg.deny ?? { private: [], groups: [] },
        ownerQQ: cfg.ownerQQ ?? null,
      });
      pushLog('console', `白名单/管理员已保存（群 ${(cfg.allow?.groups ?? []).join(',') || '无'}；私聊 ${(cfg.allow?.private ?? []).join(',') || '无'}；owner ${cfg.ownerQQ ?? '未设'}）`);
      await broadcastStatus();
      return json(res, 200, {
        ok: true,
        hot: hot.ok ? '桥接已热更新' : (hot.offline ? '桥接未运行，下次启动生效' : `桥接热更新失败：${hot.data?.error ?? '重启桥接后生效'}`),
        allow: cfg.allow,
        deny: cfg.deny,
        ownerQQ: cfg.ownerQQ ?? null,
      });
    }

    // ── 模式（chat / mention-only / reserved / reserved2 / closed-agent）──
    // mention-only（「仅@」）：群聊只在被 @ / 被引用 / 被叫名字时回，私聊同 chat。
    // 校验用同一份 CONSOLE_MODES；桥接那边还有 MODE_INPUT_ALIASES（接受 simulation 等历史名）。
    if (req.method === 'GET' && pathname === '/api/mode') {
      let mode = '';
      try { mode = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')).mode ?? ''; } catch { /* 默认 */ }
      const live = await callBridge('/api/status', 'GET', null, 4000);
      if (live.ok && live.data?.mode) mode = live.data.mode;
      return json(res, 200, { ok: true, mode, modes: CONSOLE_MODES });
    }

    if (req.method === 'POST' && pathname === '/api/mode') {
      const body = await readBody(req);
      const mode = String(body.mode ?? '').trim();
      if (!CONSOLE_MODES.includes(mode)) {
        return json(res, 400, { ok: false, message: `mode 只能是 ${CONSOLE_MODES.join(' / ')}` });
      }
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, mode });
      // 先让桥接写（它会保留 closedAgentPreset/dshSynced/dshSeenMode 并原子落盘）。
      // 桥接离线时再本地合并写，绝不能只写 { mode } 把对账字段冲掉。
      const hot = await callBridge('/api/mode', 'POST', { mode });
      if (!hot.ok && hot.offline) {
        const existing = readJsonFileSafe(MODE_FILE) || {};
        const next = { ...existing, mode, dshSynced: false };
        fs.mkdirSync(STATE_DIR, { recursive: true });
        const tmp = `${MODE_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
        fs.renameSync(tmp, MODE_FILE);
      }
      pushLog('console', `模式已设为 ${mode}`);
      await broadcastStatus();
      // mention-only 是后加的模式：运行中的 DSH 若还挂着旧版 qq-mode 插件 schema，
      // 桥接会写穿失败但按本地 state/mode.json 生效。这里如实提示，别让用户以为没切成。
      const hotText = hot.ok
        ? (mode === 'mention-only' && hot.data?.dshSynced === false
          ? '桥接已切换（DSH 插件较旧，已由本地保留；重启 DSH 后可写穿）'
          : '桥接已切换')
        : (hot.offline ? '桥接未运行，下次启动生效' : `桥接拒绝：${hot.data?.error ?? '未知错误'}`);
      return json(res, 200, {
        ok: true,
        mode,
        hot: hotText,
      });
    }

    // ── 直连 api 后端 ──────────────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/api-backend') {
      const body = await readBody(req);
      const current = normalizeApiConfig(paths.cfg.api);
      const patch = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) patch.baseUrl = body.baseUrl.trim();
      if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim();
      if (typeof body.systemPrompt === 'string') patch.systemPrompt = body.systemPrompt;
      if (typeof body.apiKey === 'string' && body.apiKey.trim() && !body.apiKey.includes('*')) patch.apiKey = body.apiKey.trim();
      if (body.groupTrigger === 'at' || body.groupTrigger === 'all') patch.groupTrigger = body.groupTrigger;
      if (typeof body.wakeWords === 'string') patch.wakeWords = body.wakeWords.split(',');
      if (body.wakeWords !== undefined && Array.isArray(body.wakeWords)) patch.wakeWords = body.wakeWords;
      if (typeof body.allowImages === 'boolean') patch.allowImages = body.allowImages;
      if (typeof body.useRoleHint === 'boolean') patch.useRoleHint = body.useRoleHint;
      for (const key of ['temperature', 'maxRetries', 'retryBackoffMs', 'timeoutMs', 'maxHistory', 'maxReplyChars', 'thinkingBudget', 'ttlMs']) {
        if (body[key] !== undefined && body[key] !== '') patch[key] = Number(body[key]);
      }
      for (const key of ['reasoningEffort', 'thinkingType']) {
        if (typeof body[key] === 'string') patch[key] = body[key];
      }

      const merged = normalizeApiConfig({ ...current, ...patch });
      if (patch.baseUrl && !/^https?:\/\//i.test(merged.baseUrl)) return json(res, 400, { ok: false, message: 'baseUrl 必须是 http(s) 地址' });
      if (merged.enabled && !merged.apiKey) return json(res, 400, { ok: false, message: '启用直连 api 前必须先填 apiKey' });

      if (dryRun) {
        return json(res, 200, { ok: true, dryRun: true, enabled: merged.enabled, model: merged.model, hasKey: Boolean(merged.apiKey), config: { ...merged, apiKey: '' } });
      }
      updateConfigFile((file) => { file.api = merged; });
      paths = runtimePaths();
      const hot = await callBridge('/api/api-backend', 'POST', { ...merged, apiKey: merged.apiKey });
      pushLog('console', `直连 api 已${merged.enabled ? '启用' : '关闭'}（${merged.model}；Key ${maskKey(merged.apiKey)}）`);
      await broadcastStatus();
      return json(res, 200, {
        ok: true,
        enabled: merged.enabled,
        model: merged.model,
        hasKey: Boolean(merged.apiKey),
        hot: hot.ok ? '桥接已热更新' : (hot.offline ? '桥接未运行，下次启动生效' : `桥接热更新失败：${hot.data?.error ?? '未知错误'}`),
      });
    }

    // 直连后端连接测试 / 拉模型列表
    if (req.method === 'POST' && (pathname === '/api/api-backend/test' || pathname === '/api/api-backend/models')) {
      const body = await readBody(req);
      const cfg = normalizeApiConfig(paths.cfg.api);
      const baseUrl = String(body.baseUrl ?? '').trim() || cfg.baseUrl;
      const apiKey = String(body.apiKey ?? '').trim() && !String(body.apiKey).includes('*') ? String(body.apiKey).trim() : cfg.apiKey;
      if (!apiKey) {
        return json(res, 200, { ok: false, mode: 'models', message: '没有 API Key：先在配置里填并保存，或在测试时临时填入', models: [] });
      }
      const list = await apiListModels({ baseUrl, apiKey, timeoutMs: Math.min(30000, Math.max(3000, Number(body.timeoutMs) || 15000)) });
      if (pathname === '/api/api-backend/models') return json(res, 200, list);
      // 测试连接：/models 成功即算连通；用户还可以要求一条真实对话
      if (list.ok && body.chat !== true) {
        return json(res, 200, {
          ok: true, mode: 'models', status: list.status, elapsed: list.elapsed,
          count: list.count, models: list.models, baseUrl: list.baseUrl,
          message: `连接正常：/models 返回 ${list.count} 个模型（${list.elapsed}ms）`,
        });
      }
      if (!list.ok && body.chat !== true) {
        return json(res, 200, { ok: false, mode: 'models', status: list.status, elapsed: list.elapsed, message: list.message, models: [] });
      }
      const started = Date.now();
      try {
        const client = new ApiChatClient({
          ...cfg, baseUrl, apiKey,
          logger: { info: (l) => pushLog('test', l), warn: (l) => pushLog('test', l, 'warn'), error: (l) => pushLog('test', l, 'error'), debug: () => {} },
        });
        const reply = await client.chat([{ role: 'user', content: String(body.message ?? '你好') }], {});
        return json(res, 200, {
          ok: true, mode: 'chat', elapsed: Date.now() - started, reply: String(reply).slice(0, 2000),
          models: list.models || [], count: list.count ?? 0,
          message: `对话成功（${Date.now() - started}ms）`,
        });
      } catch (err) {
        return json(res, 200, { ok: false, mode: 'chat', elapsed: Date.now() - started, message: `对话失败：${err.message}`, models: list.models || [] });
      }
    }

    // ── 人格 ───────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/roles') {
      const roleState = readRoleState();
      return json(res, 200, {
        ok: true,
        roles: listRoles(),
        state: roleState,
        limit: Number(paths.cfg.role?.maxInjectChars) || 6000,
      });
    }

    if (req.method === 'GET' && pathname === '/api/roles/content') {
      const name = sanitizeRoleName(url.searchParams.get('name') ?? '');
      if (!name) return json(res, 400, { ok: false, message: '缺少角色名' });
      const file = roleFile(name);
      if (!file || !fs.existsSync(file)) return json(res, 404, { ok: false, message: `角色「${name}」不存在` });
      const st = fileStat(file);
      return json(res, 200, { ok: true, name, content: fs.readFileSync(file, 'utf8'), mtime: st.mtime, bytes: st.size });
    }

    if (req.method === 'POST' && pathname === '/api/roles/content') {
      const body = await readBody(req);
      const name = sanitizeRoleName(body.name);
      if (!name) return json(res, 400, { ok: false, message: '角色名不合法（只允许中英文、数字、下划线、连字符）' });
      const content = String(body.content ?? '');
      if (!content.trim()) return json(res, 400, { ok: false, message: '角色内容不能为空' });
      if (content.length > 60_000) return json(res, 400, { ok: false, message: '角色内容过长（上限 60000 字）' });
      const existed = fs.existsSync(path.join(ROLES_DIR, `${name}.md`));
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, name, existed, chars: content.length });
      fs.mkdirSync(ROLES_DIR, { recursive: true });
      fs.writeFileSync(path.join(ROLES_DIR, `${name}.md`), content, 'utf8');
      pushLog('console', `角色「${name}」已${existed ? '更新' : '新建'}（${content.length} 字）`);
      return json(res, 200, { ok: true, name, existed, message: '已保存，对下一条消息生效' });
    }

    if (req.method === 'POST' && pathname === '/api/roles/delete') {
      const body = await readBody(req);
      const name = sanitizeRoleName(body.name);
      const file = roleFile(name);
      if (!name || !file || !fs.existsSync(file)) return json(res, 404, { ok: false, message: '角色不存在' });
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, name });
      fs.unlinkSync(file);
      if (readRoleState().role === name) writeRoleState(null, readRoleState().mode);
      pushLog('console', `角色「${name}」已删除`, 'warn');
      return json(res, 200, { ok: true, name, message: '已删除' });
    }

    if (req.method === 'POST' && pathname === '/api/roles/rename') {
      const body = await readBody(req);
      const from = sanitizeRoleName(body.from);
      const to = sanitizeRoleName(body.to);
      if (!from || !to) return json(res, 400, { ok: false, message: '新旧角色名都不能为空' });
      const srcFile = roleFile(from);
      const dstFile = roleFile(to);
      if (!srcFile || !fs.existsSync(srcFile)) return json(res, 404, { ok: false, message: `角色「${from}」不存在` });
      if (dstFile && fs.existsSync(dstFile)) return json(res, 409, { ok: false, message: `角色「${to}」已存在` });
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, from, to });
      fs.renameSync(srcFile, dstFile);
      if (readRoleState().role === from) writeRoleState(to, readRoleState().mode);
      pushLog('console', `角色已重命名：${from} → ${to}`);
      return json(res, 200, { ok: true, from, to, message: '已重命名' });
    }

    if (req.method === 'POST' && pathname === '/api/roles/duplicate') {
      const body = await readBody(req);
      const from = sanitizeRoleName(body.from);
      const to = sanitizeRoleName(body.to);
      if (!from || !to) return json(res, 400, { ok: false, message: '源角色名和副本名都不能为空' });
      const srcFile = roleFile(from);
      const dstFile = roleFile(to);
      if (!srcFile || !fs.existsSync(srcFile)) return json(res, 404, { ok: false, message: `角色「${from}」不存在` });
      if (dstFile && fs.existsSync(dstFile)) return json(res, 409, { ok: false, message: `角色「${to}」已存在` });
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, from, to });
      fs.copyFileSync(srcFile, dstFile);
      pushLog('console', `角色已复制：${from} → ${to}`);
      return json(res, 200, { ok: true, from, to, message: '已复制' });
    }

    if (req.method === 'POST' && pathname === '/api/roles/current') {
      const body = await readBody(req);
      const raw = String(body.role ?? '').trim();
      const mode = ['active', 'silent'].includes(body.mode) ? body.mode : (readRoleState().mode ?? 'active');
      if (!raw || raw === 'off' || raw === 'none') {
        if (dryRun) return json(res, 200, { ok: true, dryRun: true, role: null, mode });
        writeRoleState(null, mode);
        pushLog('console', '已清除角色，恢复正常人格');
        return json(res, 200, { ok: true, role: null, mode });
      }
      const name = sanitizeRoleName(raw);
      if (!name || !fs.existsSync(path.join(ROLES_DIR, `${name}.md`))) {
        return json(res, 404, { ok: false, message: `角色「${raw}」不存在` });
      }
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, role: name, mode });
      writeRoleState(name, mode);
      pushLog('console', `已切换角色：${name}（${mode}）`);
      return json(res, 200, { ok: true, role: name, mode });
    }

    // ── 会话 ───────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/sessions') {
      return json(res, 200, await buildSessions());
    }

    if (req.method === 'GET' && pathname === '/api/session/messages') {
      const key = String(url.searchParams.get('key') || '');
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
      if (!key) return json(res, 400, { ok: false, message: '缺少 key' });
      const [recent, unread] = await Promise.all([
        callBridge(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit}`, 'GET', null, 8000),
        callBridge(`/api/socialV2/unread?key=${encodeURIComponent(key)}`, 'GET', null, 8000),
      ]);
      if (!recent.ok && recent.offline) return json(res, 200, { ok: false, offline: true, message: '桥接未运行' });
      return json(res, 200, {
        ok: true,
        key,
        recent: recent.ok ? (recent.data?.messages ?? []) : [],
        unread: unread.ok ? (unread.data?.messages ?? []) : [],
        unreadCount: unread.ok ? (unread.data?.unreadCount ?? 0) : 0,
        error: recent.ok ? '' : (recent.data?.error || '桥接返回异常'),
      });
    }

    if (req.method === 'POST' && pathname === '/api/sessions/reset') {
      const body = await readBody(req);
      const key = String(body.key ?? '');
      if (!key) return json(res, 400, { ok: false, message: '缺少 key' });
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, key });
      const r = await callBridge('/api/session/reset', 'POST', { key });
      if (r.offline) {
        pushLog('console', `桥接未运行，无法重置会话 ${key}`, 'warn');
        return json(res, 200, { ok: false, offline: true, message: '桥接未运行：无法重置（重启桥接后再试）' });
      }
      pushLog('console', r.ok ? `会话已重置：${key}` : `会话重置失败：${key}（${r.data?.error ?? r.status}）`, r.ok ? 'info' : 'warn');
      return json(res, 200, { ok: Boolean(r.ok), message: r.ok ? `会话 ${key} 已重置` : (r.data?.error || '重置失败') });
    }

    if (req.method === 'POST' && pathname === '/api/sessions/clear') {
      if (dryRun) return json(res, 200, { ok: true, dryRun: true });
      const r = await callBridge('/api/workspace/reset', 'POST', {});
      if (r.offline) return json(res, 200, { ok: false, offline: true, message: '桥接未运行：无法清空会话' });
      pushLog('console', r.ok ? '已清空全部会话（桥接 workspace reset）' : '清空会话失败', r.ok ? 'warn' : 'error');
      return json(res, 200, {
        ok: Boolean(r.ok),
        message: r.ok ? '已清空全部会话（旧会话已归档）' : (r.data?.error || '清空失败'),
        detail: r.data ?? null,
      });
    }

    // ── 会话共用小黑板 ─────────────────────────────────────────────────
    // 直通桥接的 /api/socialV2/board：读 / 写 / 删一条 / 清空。
    // 控制台自身只用 scope=console（不带 agent token），桥接那边按控制台鉴权放行。
    if (req.method === 'GET' && pathname === '/api/board') {
      const key = String(url.searchParams.get('key') || '').trim();
      if (!key) return json(res, 400, { ok: false, message: '缺少 key' });
      const r = await callBridge(`/api/socialV2/board?key=${encodeURIComponent(key)}`, 'GET', null, 6000);
      if (r.offline) return json(res, 200, { ok: false, offline: true, message: '桥接未运行' });
      return json(res, r.ok ? 200 : 502, r.data ?? { ok: false });
    }

    if (req.method === 'POST' && pathname === '/api/board') {
      const body = await readBody(req);
      const key = String(body.key ?? '').trim();
      const text = String(body.text ?? '').trim();
      if (!key) return json(res, 400, { ok: false, message: '缺少 key' });
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, key, text });
      const r = await callBridge('/api/socialV2/board', 'POST', { key, text, by: 'console' }, 6000);
      if (r.offline) return json(res, 200, { ok: false, offline: true, message: '桥接未运行' });
      if (r.ok) pushLog('console', `小黑板：${key} 写入一条（控制台）`);
      return json(res, r.ok ? 200 : 502, r.data ?? { ok: false });
    }

    if (req.method === 'POST' && pathname === '/api/board/clear') {
      const body = await readBody(req);
      const key = String(body.key ?? '').trim();
      if (!key) return json(res, 400, { ok: false, message: '缺少 key' });
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, key });
      const payload = { key };
      if (body.index !== undefined && body.index !== null && body.index !== '') payload.index = Number(body.index);
      const r = await callBridge('/api/socialV2/board/clear', 'POST', payload, 6000);
      if (r.offline) return json(res, 200, { ok: false, offline: true, message: '桥接未运行' });
      if (r.ok) pushLog('console', `小黑板：${key} ${payload.index === undefined ? '清空' : `删除第 ${payload.index} 条`}`);
      return json(res, r.ok ? 200 : 502, r.data ?? { ok: false });
    }

    // ── 余额 ───────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/balance') {
      return json(res, 200, await fetchBalance({ force: url.searchParams.get('force') === '1' }));
    }

    // ── token / 花费 ───────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/tokens') {
      const data = await tokenSummary({ force: url.searchParams.get('force') === '1' });
      return json(res, 200, data);
    }
    if (req.method === 'GET' && pathname === '/api/tokens/series') {
      const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      const buckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
      return json(res, 200, await tokenSeries({ hours, buckets }));
    }
    if (req.method === 'GET' && pathname === '/api/tokens/recent') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const live = await callBridge(`/api/tokens/recent?limit=${limit}`, 'GET', null, 7000);
      if (live.ok && live.data?.ok) return json(res, 200, { ...live.data, source: 'bridge' });
      return json(res, 200, { ok: true, source: 'local', entries: readRecentTokens(limit), symbol: '¥' });
    }
    if (req.method === 'GET' && pathname === '/api/tokens/features') {
      // 按功能分账：桥接在线走 /api/tokens/features；离线回退本地 jsonl + sessions.json 归属。
      const hours = Math.max(0, Number(url.searchParams.get('hours')) || 0);
      const live = await callBridge('/api/tokens/features' + (hours > 0 ? `?hours=${hours}` : ''), 'GET', null, 9000);
      if (live.ok && live.data?.ok) return json(res, 200, { ...live.data, source: 'bridge' });
      const entries = readJsonl(TOKEN_LEDGER_FILE);
      const since = hours > 0 ? Date.now() - hours * 3600_000 : 0;
      const stats = localFeatureStats(entries, localSessionFeatureMap(), since);
      return json(res, 200, { ok: true, source: 'local', symbol: '¥', hours, degraded: true, ...stats });    }
    if (req.method === 'GET' && pathname === '/api/tokens/models') {
      const hours = Math.max(0, Number(url.searchParams.get('hours')) || 0);
      const live = await callBridge('/api/tokens/models' + (hours > 0 ? `?hours=${hours}` : ''), 'GET', null, 9000);
      if (live.ok && live.data?.ok) {
        // 标注分工：WorkBuddy 网关的模型=基础；其余（DeepSeek 官方）=进阶/内部
        let wbIds = new Set();
        try {
          if (paths.workbuddyDir) {
            const wb = await workbuddyModels();
            wbIds = new Set((wb.ids || []).map(String));
          }
        } catch { /* 忽略 */ }
        const models = (live.data.models || []).map((m) => ({
          ...m,
          role: wbIds.has(String(m.model)) ? 'basic' : 'advanced',
        }));
        return json(res, 200, { ...live.data, models, source: 'bridge' });
      }
      // 降级：桥接离线时按本地 jsonl 聚合（只算 token，没有价格）
      const entries = readJsonl(TOKEN_LEDGER_FILE);
      // 时间窗口必须照样生效：否则 /api/tokens/models?hours=24 在桥接离线时会把「全时段」
      // 的数字当成「近 24 小时」返回（余额明细弹窗曾因此显示「近 24h 花费 ¥0 + 全时段 token」）。
      const since = hours > 0 ? Date.now() - hours * 3600_000 : 0;
      const map = new Map();
      for (const e of entries) {
        if (e.k !== 'turn' || !e.b) continue;
        if (since && (Number(e.t) || 0) < since) continue;
        const model = String(e.model || 'unknown');
        let r = map.get(model);
        if (!r) {
          r = { model, buckets: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 }, steps: 0, turns: new Set(), sessions: new Set(), firstAt: 0, lastAt: 0 };
          map.set(model, r);
        }
        for (const k of Object.keys(r.buckets)) r.buckets[k] += Number(e.b[k]) || 0;
        r.steps += 1;
        r.turns.add(`${e.sid}:${e.turn}`);
        if (e.sid) r.sessions.add(e.sid);
        r.lastAt = Math.max(r.lastAt, Number(e.t) || 0);
        r.firstAt = r.firstAt ? Math.min(r.firstAt, Number(e.t) || 0) : (Number(e.t) || 0);
      }
      const models = [...map.values()].map((r) => {
        const totalTokens = Object.values(r.buckets).reduce((sum, v) => sum + (Number(v) || 0), 0);
        const inputTokens = r.buckets.cacheMiss + r.buckets.cacheHit + r.buckets.cacheWrite;
        return {
          model: r.model, buckets: r.buckets, cost: 0, turns: r.turns.size, steps: r.steps,
          sessions: r.sessions.size, firstAt: r.firstAt, lastAt: r.lastAt,
          totalTokens, inputTokens,
          cacheHitRate: inputTokens > 0 ? r.buckets.cacheHit / inputTokens : 0,
          estimated: true,
        };
      }).sort((a, b) => b.totalTokens - a.totalTokens);
      return json(res, 200, { ok: true, source: 'local', degraded: true, hours, symbol: '¥', models });
    }
    if (req.method === 'GET' && pathname === '/api/tokens/turns') {
      const key = String(url.searchParams.get('key') || '');
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      if (!key) return json(res, 400, { ok: false, message: '缺少 key' });
      const live = await callBridge(`/api/tokens/turns?key=${encodeURIComponent(key)}&limit=${limit}`, 'GET', null, 7000);
      if (live.ok) return json(res, 200, live.data);
      return json(res, 200, { ok: false, offline: true, message: '桥接未运行，无法读取逐轮明细' });
    }
    if (req.method === 'POST' && pathname === '/api/tokens/reset') {
      if (dryRun) return json(res, 200, { ok: true, dryRun: true });
      const live = await callBridge('/api/tokens/reset', 'POST', {});
      if (!live.ok) return json(res, 200, { ok: false, message: live.offline ? '桥接未运行' : (live.data?.error || '重置失败') });
      tokenCache = { at: 0, data: null };
      pushLog('console', 'token 用量账本已重置', 'warn');
      return json(res, 200, { ok: true, message: '账本已重置' });
    }

    // ── NapCat ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/napcat/sysinfo') {
      return json(res, 200, await napcatSysInfo());
    }
    if (req.method === 'GET' && pathname === '/api/napcat') {
      const force = url.searchParams.get('force') === '1';
      const [info, login] = await Promise.all([
        napcatStatus({ force }),
        (async () => {
          const { token, port, disabled } = readNapcatWebuiToken();
          if (!token || disabled) return { ok: false, reason: '未找到 WebUI token', port };
          return { ok: true, port };
        })(),
      ]);
      return json(res, 200, {
        ok: true,
        up: await probe(paths.napcatWsPort),
        httpUp: await probe(paths.napcatHttpPort),
        webuiUp: await probe(paths.napcatWebuiPort),
        webui: info.webui,
        login: info.login,
        info: info.info,
        onebot: info.onebot,
        quickLogin: info.quickLogin,
        error: info.error,
        mode: napcatMode(),
        container: dockerContainerInfo(),
        dir: paths.napcatDir,
        qq: paths.napcatQQ,
        ports: { ws: paths.napcatWsPort, http: paths.napcatHttpPort, webui: paths.napcatWebuiPort },
        webuiLink: login.ok ? `http://127.0.0.1:${login.port}` : '',
      });
    }

    if (req.method === 'POST' && pathname === '/api/napcat/qrcode') {
      const body = await readBody(req);
      const refresh = body.refresh === true;
      if (refresh) await napcatWebuiApi('/api/QQLogin/RefreshQRcode', {});
      const r = await napcatWebuiApi('/api/QQLogin/GetQQLoginQrcode', {});
      if (!r.ok) {
        const reason = String(r.error || '');
        if (/logined|已登录/i.test(reason)) {
          return json(res, 200, { ok: true, loggedIn: true, message: 'QQ 已登录，无需二维码' });
        }
        return json(res, 200, { ok: false, message: reason || '获取二维码失败', webuiUrl: `http://127.0.0.1:${r.port || paths.napcatWebuiPort}` });
      }
      const qr = String(r.data?.qrcode ?? r.data ?? '');
      const dataUrl = qr.startsWith('data:') ? qr : (qr.startsWith('http') ? qr : `data:image/png;base64,${qr}`);
      napcatWebuiCache2.at = 0;
      pushLog('console', '已获取 NapCat 登录二维码（请用手机 QQ 扫码）');
      return json(res, 200, { ok: true, qrcode: dataUrl, message: '扫码登录', refresh });
    }

    // ── 测试对话 / QQ 测试 ─────────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/test') {
      const body = await readBody(req);
      const message = String(body.message ?? '').trim() || '你好，介绍一下你自己';
      const backend = body.backend === 'qq' ? 'qq' : 'api';
      if (backend === 'qq') {
        const target = String(body.target ?? '').trim();
        if (!target) return json(res, 400, { ok: false, message: '发 QQ 测试消息需要填目标（group:群号 或 private:QQ号）' });
        const kind = target.startsWith('group:') ? 'group' : 'private';
        const id = Number(target.split(':')[1]);
        if (!Number.isSafeInteger(id) || id <= 0) return json(res, 400, { ok: false, message: '目标格式不对，示例 group:100000003' });
        const r = await callBridge('/api/test-send', 'POST', { kind, id, message });
        return json(res, 200, {
          ok: r.ok && (r.data?.ok !== false),
          backend: 'qq',
          message: r.offline ? '桥接未运行，无法发送' : (r.data?.error ?? '已通过桥接发送（看 QQ 是否收到）'),
        });
      }
      return json(res, 200, await testApiChat(message));
    }

    // ── 诊断 / 备份 ────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/diagnostics') {
      return json(res, 200, await buildDiagnostics());
    }

    if (req.method === 'GET' && pathname === '/api/backups') {
      return json(res, 200, { ok: true, dir: BACKUPS_DIR, items: listBackups() });
    }

    if (req.method === 'POST' && pathname === '/api/backup') {
      const body = await readBody(req);
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, message: '将备份 config.json + state/* + roles/*.md' });
      const r = createBackup(String(body.note ?? 'manual').slice(0, 20));
      return json(res, 200, { ...r, message: `已备份 ${r.files} 个文件到 backups/${r.name}` });
    }

    if (req.method === 'POST' && pathname === '/api/backup/restore') {
      const body = await readBody(req);
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, name: body.name });
      const r = restoreBackup(body.name);
      await broadcastStatus();
      return json(res, 200, r);
    }

    if (req.method === 'POST' && pathname === '/api/backup/delete') {
      const body = await readBody(req);
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, name: body.name });
      return json(res, 200, deleteBackup(body.name));
    }

    // ── 打开目录 / 文件 ────────────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/open') {
      const body = await readBody(req);
      const targets = {
        root: ROOT,
        console: CONSOLE_DIR,
        state: STATE_DIR,
        roles: ROLES_DIR,
        backups: BACKUPS_DIR,
        bridgeLog: BRIDGE_LOG,
        activityLog: ACTIVITY_LOG,
        tokenLedger: TOKEN_LEDGER_FILE,
        config: CONFIG_PATH,
        napcat: paths.napcatDir,
        dsh: DSH_INSTALL,
        memory: path.join(STATE_DIR, 'memory'),
        memoryVault: (() => {
          try { return getMemory().vaultDir(); } catch { return path.join(STATE_DIR, 'memory-vault'); }
        })(),
      };
      const target = targets[String(body.target || '')];
      if (!target) return json(res, 400, { ok: false, message: '未知的打开目标' });
      if (!fs.existsSync(target)) return json(res, 404, { ok: false, message: `路径不存在：${target}` });
      const st = fileStat(target);
      const args2 = st.isFile ? ['/select,', target] : [target];
      try {
        const child = spawn('explorer.exe', args2, { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
        pushLog('console', `已打开 ${st.isFile ? '文件位置' : '目录'}：${target}`);
        return json(res, 200, { ok: true, target, message: '已打开（资源管理器）' });
      } catch (err) {
        return json(res, 500, { ok: false, message: err.message });
      }
    }

    // ── 设置 ───────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/settings') {
      return json(res, 200, { ok: true, settings: readSettings(), defaults: SETTINGS_DEFAULTS });
    }
    if (req.method === 'POST' && pathname === '/api/settings') {
      const body = await readBody(req);
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, settings: normalizeSettings({ ...readSettings(), ...body }) });
      const next = writeSettings(body);
      pushLog('console', `控制台设置已保存（主题 ${next.theme}；轮询 ${next.pollMs}ms；字号 ${next.fontSize}）`);
      return json(res, 200, { ok: true, settings: next });
    }

    // ── 记忆大脑（state/memory/brain.json + Obsidian vault）────────────
    // 只读统计 / 列表 / 图谱 / 最近事件 / SVG；写操作走下面的细粒度 POST。
    if (req.method === 'GET' && pathname === '/api/memory/overview') {
      try {
        const svc = getMemory();
        const brain = svc.snapshot();
        const stats = svc.stats();
        const list = Object.values(brain.memories || {}).slice()
          .sort((a, b) => (Number(b.strength) || 0) - (Number(a.strength) || 0)
            || (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
          .slice(0, 80);
        const entities = Object.values(brain.entities || {}).slice()
          .sort((a, b) => (Number(b.mentionCount) || 0) - (Number(a.mentionCount) || 0))
          .slice(0, 80);
        const pathsInfo = svc.paths();
        const vaultDir = svc.vaultDir();
        const svgPath = path.join(vaultDir, '图谱', '记忆大脑.svg');
        const brainStat = fileStat(pathsInfo.brainPath);
        const vaultStat = fileStat(vaultDir);
        return json(res, 200, {
          ok: true,
          ts: Date.now(),
          stats,
          memories: list.map((m) => publicMemory(m, { includeText: true, includeRecallLog: false })),
          entities: entities.map(publicEntity),
          events: svc.recentEvents({ limit: 15 }),
          config: brain.config || {},
          paths: {
            brainPath: pathsInfo.brainPath,
            eventsPath: pathsInfo.eventsPath,
            memoryDir: pathsInfo.memoryDir,
            vaultDir,
            svgPath,
            brainSize: brainStat.sizeText,
            brainMtime: brainStat.mtime,
            vaultExists: vaultStat.exists,
          },
          obsidianUri: obsidianUri(),
        });
      } catch (err) { return memoryError(res, err); }
    }

    // 记忆仿真：读取报告 / 后台重跑（不写真实 brain.json）。
    if (req.method === 'GET' && pathname === '/api/memory/sim') {
      try {
        return json(res, 200, {
          ok: true,
          reports: readSimReports(),
          running: simRunState.running,
          lastRun: simRunState,
          logTail: readSimLogTail(),
        });
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/sim/run') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        if (simRunState.running) {
          return json(res, 409, { ok: false, message: `仿真正在运行（pid ${simRunState.pid}），等它跑完再试` });
        }
        const messages = Math.min(500000, Math.max(1000, Math.round(Number(body.messages) || 200000)));
        const days = Math.min(365, Math.max(1, Math.round(Number(body.days) || 60)));
        const seed = Math.min(2147483647, Math.max(1, Math.round(Number(body.seed) || 42)));
        const legacyCap = body.cap === undefined || body.cap === null ? null : Math.min(200000, Math.max(100, Math.round(Number(body.cap) || 5000)));
        const capLong = legacyCap ?? Math.min(500000, Math.max(100, Math.round(Number(body.capLong) || DEFAULT_CAP_LONG)));
        const capShort = legacyCap ?? Math.min(200000, Math.max(100, Math.round(Number(body.capShort) || DEFAULT_CAP_SHORT)));
        const rawName = String(body.jsonName || '').trim();
        const safeName = rawName && /^[A-Za-z0-9._-]{1,64}$/.test(rawName) ? rawName.replace(/^\.+/, '') : '';
        const outName = safeName ? (safeName.endsWith('.json') ? safeName : safeName + '.json') : `sim-report-console-${Date.now()}.json`;
        fs.mkdirSync(SIM_DIR, { recursive: true });
        const logPath = path.join(SIM_DIR, 'sim-run.log');
        const fd = fs.openSync(logPath, 'a');
        fs.writeSync(fd, `\n===== ${new Date().toISOString()} run messages=${messages} days=${days} seed=${seed} capLong=${capLong} capShort=${capShort} -> ${outName}\n`);
        const args = [
          SIM_SCRIPT,
          '--messages', String(messages),
          '--days', String(days),
          '--seed', String(seed),
          '--cap-long', String(capLong),
          '--cap-short', String(capShort),
          '--json-out', path.join(SIM_DIR, outName),
        ];
        const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
        child.unref();
        simRunState = { running: true, startedAt: Date.now(), params: { messages, days, seed, capLong, capShort, jsonName: outName }, pid: child.pid, finishedAt: 0, exitCode: null };
        child.on('exit', (code) => {
          simRunState = { ...simRunState, running: false, finishedAt: Date.now(), exitCode: code };
          try { fs.closeSync(fd); } catch { /* ignore */ }
        });
        pushLog('memory', `记忆仿真启动：${messages} 条 / ${days} 天 / long ${capLong} / short ${capShort}`);
        return json(res, 200, { ok: true, started: true, pid: child.pid, params: simRunState.params, outFile: outName });
      } catch (err) { return memoryError(res, err); }
    }
    // v1.9：对话调度（逐条路由 / 泳道 / 唤醒参数 / 离线自检）
    if (req.method === 'GET' && pathname === '/api/routing/summary') {
      const [dec, states] = await Promise.all([
        callBridge('/api/route-decisions?limit=60', 'GET', null, 10000),
        callBridge('/api/socialV2/states', 'GET', null, 10000),
      ]);
      const cfgNow = (paths && paths.cfg) || {};
      const social = cfgNow.socialV2 || {};
      const routingDefaults = { perMessage: true, laneWaitMs: 180000, maxMessages: 10, parallelLanes: false, log: true };
      return json(res, 200, {
        ok: true,
        decisions: dec.data && dec.data.ok ? dec.data.decisions : [],
        decisionsOk: Boolean(dec.data && dec.data.ok),
        decisionsError: dec.ok ? '' : (dec.error || ''),
        conversations: states.data && states.data.ok ? states.data.conversations : [],
        statesOk: Boolean(states.data && states.data.ok),
        features: cfgNow.dsh && cfgNow.dsh.features ? cfgNow.dsh.features : {},
        routing: Object.assign(routingDefaults, social.routing || {}),
        wake: social.wake || {},
        proactive: social.proactive || {},
        context: social.context || {},
        send: social.send || {},
      });
    }

    if (req.method === 'POST' && pathname === '/api/routing/selftest') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const messages = Array.isArray(body.messages) ? body.messages.slice(0, 10).map((m, i) => ({
          seq: Number(m.seq ?? i + 1),
          messageId: Number(m.messageId ?? i + 1),
          isSelf: Boolean(m.isSelf),
          text: String(m.text ?? '').slice(0, 200),
          media: Array.isArray(m.media) ? m.media.slice(0, 3).map((x) => ({ kind: String(x && x.kind ? x.kind : 'image') })) : [],
          sender: 'selftest',
        })) : [];
        const r = await callBridge('/api/routing/selftest', 'POST', {
          messages,
          isGroup: Boolean(body.isGroup),
          key: typeof body.key === 'string' ? body.key : undefined,
          wakeReason: 'selftest-console',
          log: body.log === true,
        }, 20000);
        if (!r.ok || !r.data) return json(res, 502, { ok: false, message: r.error || (r.data && r.data.error) || '桥接不可用' });
        pushLog('bridge', '路由自检：' + messages.length + ' 条消息');
        return json(res, 200, r.data);
      } catch (err) {
        return json(res, 500, { ok: false, message: '路由自检失败：' + err.message });
      }
    }

    // v1.8：主从 agent 委派（桥接管理端视图：统计 / 配置）
    if (req.method === 'GET' && pathname === '/api/delegate/stats') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 30));
      const r = await callBridge('/api/delegate/stats?limit=' + limit, 'GET', null, 10000);
      if (!r.ok || !r.data) return json(res, 502, { ok: false, message: r.error || (r.data && r.data.error) || '桥接不可用' });
      return json(res, 200, r.data);
    }

    if (req.method === 'POST' && pathname === '/api/delegate/config') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const r = await callBridge('/api/delegate/config', 'POST', body, 10000);
        if (!r.ok || !r.data) return json(res, 502, { ok: false, message: r.error || (r.data && r.data.error) || '桥接不可用' });
        pushLog('memory', '委派配置更新：' + JSON.stringify(body));
        return json(res, 200, r.data);
      } catch (err) { return json(res, 500, { ok: false, message: '委派配置写入失败：' + err.message }); }
    }

    if (req.method === 'POST' && pathname === '/api/delegate/reset') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        if (!body || body.confirm !== true) return json(res, 400, { ok: false, message: '需要 confirm:true' });
        const r = await callBridge('/api/delegate/reset', 'POST', { confirm: true }, 10000);
        if (!r.ok || !r.data) return json(res, 502, { ok: false, message: r.error || (r.data && r.data.error) || '桥接不可用' });
        pushLog('memory', '委派记录已清空');
        return json(res, 200, r.data);
      } catch (err) { return json(res, 500, { ok: false, message: '清空委派记录失败：' + err.message }); }
    }

    // v1.5-lite：人格状态（精力/心情），返回感受词 + 内部数值。
    if (req.method === 'GET' && pathname === '/api/memory/state') {
      try {
        return json(res, 200, getMemory().state());
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'GET' && pathname === '/api/memory/memories') {
      try {
        const svc = getMemory();
        const q = String(url.searchParams.get('q') || '').trim();
        const layer = String(url.searchParams.get('layer') || '').trim();
        const status = String(url.searchParams.get('status') || '').trim();
        const tag = String(url.searchParams.get('tag') || '').trim().toLowerCase();
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        let memories;
        let total;
        let hint = '';
        if (q) {
          const raw = { query: q, limit };
          if (layer) raw.layer = layer;
          if (status) raw.status = status;
          const r = svc.search(raw);
          memories = r.memories;
          total = r.total;
          hint = r.hint || '';
        } else {
          const brain = svc.snapshot();
          let list = Object.values(brain.memories || {}).slice();
          if (layer) list = list.filter((m) => m.layer === layer);
          if (status) list = list.filter((m) => m.status === status);
          // 标签过滤必须在截断前做，否则 limit 较小（如 10）时只会从「最近 N 条」里挑，
          // total 也会被截成错误数量（2026-10-28 修：?tag=bugfix&limit=10 只返回 2 条）。
          if (tag) list = list.filter((m) => Array.isArray(m?.tags) && m.tags.some((t) => String(t).toLowerCase() === tag));
          list.sort((a, b) => (Number(b.strength) || 0) - (Number(a.strength) || 0));
          total = list.length;
          memories = list.slice(0, limit).map((m) => publicMemory(m, { includeText: true }));
        }
        if (tag && q) {
          // 搜索分支的结果已按 limit 截断，这里只能过滤返回集；total 以过滤后的可见结果为准。
          memories = memories.filter((m) => Array.isArray(m?.tags) && m.tags.some((t) => String(t).toLowerCase() === tag));
          total = memories.length;
        }
        return json(res, 200, { ok: true, total, hint, memories });
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'GET' && pathname === '/api/memory/entities') {
      try {
        const svc = getMemory();
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
        const type = String(url.searchParams.get('type') || '').trim();
        const limit = Math.min(300, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        const brain = svc.snapshot();
        let list = Object.values(brain.entities || {}).slice();
        if (type) list = list.filter((e) => e.type === type);
        if (q) {
          list = list.filter((e) => String(e.name || '').toLowerCase().includes(q)
            || (Array.isArray(e.aliases) && e.aliases.some((a) => String(a).toLowerCase().includes(q))));
        }
        list.sort((a, b) => (Number(b.mentionCount) || 0) - (Number(a.mentionCount) || 0));
        return json(res, 200, { ok: true, total: list.length, entities: list.slice(0, limit).map(publicEntity) });
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'GET' && pathname === '/api/memory/graph') {
      try {
        const svc = getMemory();
        const raw = { limit: Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 60)) };
        const entity = String(url.searchParams.get('entity') || '').trim();
        const depth = Number(url.searchParams.get('depth'));
        if (entity) raw.entity = entity;
        if (Number.isInteger(depth) && depth >= 1 && depth <= 3) raw.depth = depth;
        return json(res, 200, { ok: true, ...svc.graph(raw) });
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'GET' && pathname === '/api/memory/neural') {
      try {
        const svc = getMemory();
        const brain = svc.snapshot();
        const stats = svc.stats();
        const now = Date.now();
        const mems = Object.values(brain.memories || {});
        const ents = Object.values(brain.entities || {});
        const rels = Object.values(brain.relations || {});
        const MEM_COLORS = { permanent: '#ffd166', diary: '#2dd4bf', long: '#4d8dff', short: '#9aa7b8', archived: '#3a4250', superseded: '#6d5b9a' };
        const ENT_COLORS = { self: '#ff6ad5', group: '#4d8dff', person: '#37d67a', topic: '#ff9f43', term: '#a78bfa', event: '#f87171', project: '#67e8f9' };
        const isDiary = (m) => Array.isArray(m && m.tags) && m.tags.some((t) => String(t).toLowerCase() === 'diary');
        const nodes = [];
        const nodeIds = new Set();
        for (const m of mems) {
          const archived = m.status === 'archived';
          const superseded = m.status === 'superseded';
          const diary = isDiary(m);
          const layer = m.layer === 'long' ? 'long' : 'short';
          const color = archived
            ? MEM_COLORS.archived
            : superseded
              ? MEM_COLORS.superseded
              : diary
                ? MEM_COLORS.diary
                : Number(m.protection) >= 1
                  ? MEM_COLORS.permanent
                  : MEM_COLORS[layer];
          nodes.push({
            id: m.id,
            kind: 'memory',
            label: String(m.title || m.id).slice(0, 44),
            layer,
            category: String(m.category || ''),
            status: String(m.status || 'active'),
            archived,
            superseded,
            deprioritized: Boolean(m.deprioritized),
            supersededBy: m.supersededBy || null,
            diary,
            permanent: Number(m.protection) >= 1,
            strength: Number(m.strength) || 0,
            activationCount: Number(m.activationCount) || 0,
            lastActivatedAt: Number(m.lastActivatedAt) || 0,
            tier: memoryTier(m, now),
            text: String(m.text || '').slice(0, 220),
            color,
            size: superseded ? 3.5 : (archived ? 3 : 4) + (Number(m.strength) || 0) * 4 + (Number(m.protection) >= 1 ? 3 : 0),
          });
          nodeIds.add(m.id);
        }
        for (const e of ents) {
          nodes.push({
            id: e.id,
            kind: 'entity',
            label: String(e.name || e.id).slice(0, 44),
            type: String(e.type || ''),
            mentionCount: Number(e.mentionCount) || 0,
            note: String(e.note || '').slice(0, 160),
            color: ENT_COLORS[e.type] || '#8b95a7',
            size: 4.5 + Math.min(10, Number(e.mentionCount) || 0),
          });
          nodeIds.add(e.id);
        }
        const links = [];
        const linkKeys = new Set();
        const addLink = (source, target, kind, weight, relation) => {
          if (!source || !target || source === target) return;
          if (!nodeIds.has(source) || !nodeIds.has(target)) return;
          const key = kind + ':' + (source < target ? source + '|' + target : target + '|' + source);
          if (linkKeys.has(key)) return;
          linkKeys.add(key);
          const link = { source, target, kind, weight: Number(weight) || 0.3 };
          if (relation) link.relation = relation;
          links.push(link);
        };
        for (const m of mems) {
          const ids = Array.isArray(m.entityIds) ? m.entityIds : [];
          for (const eid of ids) addLink(m.id, eid, 'bind', 0.3);
        }
        for (const r of rels) addLink(r.from, r.to, 'relation', Number(r.weight) || 0.4, String(r.relation || 'related'));
        // v1.3 Hebbian 共激活突触：同一轮召回一起出现的记忆之间的边。
        for (const s of Array.isArray(brain.synapses) ? brain.synapses : []) {
          addLink(s.from, s.to, 'synapse', Number(s.weight) || 0.3, 'coactivated');
        }
        const activeMems = mems.filter((m) => m.status !== 'archived');
        const echoCount = new Map();
        for (let i = 0; i < activeMems.length; i += 1) {
          const a = activeMems[i];
          const aText = String(a.title || '') + '\n' + String(a.text || '');
          const best = [];
          for (let j = 0; j < activeMems.length; j += 1) {
            if (i === j) continue;
            const b = activeMems[j];
            const sim = textSimilarity(aText, String(b.title || '') + '\n' + String(b.text || ''));
            if (sim >= 0.42) best.push({ sim, id: b.id });
          }
          best.sort((x, y) => y.sim - x.sim);
          for (const item of best.slice(0, 2)) {
            const from = a.id;
            const to = item.id;
            const key = from < to ? from + '|' + to : to + '|' + from;
            if (echoCount.get(key)) continue;
            echoCount.set(key, 1);
            addLink(from, to, 'echo', Math.min(0.9, item.sim));
          }
        }
        // v1.4：关系边补上所属大类与中文标签，前端按 5 类着色。
        for (const link of links) {
          if (link.kind !== 'relation') continue;
          link.group = relationGroupOf(link.relation);
          link.label = relationLabelOf(link.relation);
        }
        const degree = new Map();
        for (const link of links) {
          degree.set(link.source, (degree.get(link.source) || 0) + 1);
          degree.set(link.target, (degree.get(link.target) || 0) + 1);
        }
        for (const node of nodes) node.degree = degree.get(node.id) || 0;
        let consolidation = null;
        try {
          const metricsPath = path.join(svc.paths().memoryDir, 'last-consolidation.json');
          if (fs.existsSync(metricsPath)) consolidation = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
        } catch { consolidation = null; }
        const nodeCount = nodes.length;
        const linkCount = links.length;
        const maxPairs = nodeCount > 1 ? (nodeCount * (nodeCount - 1)) / 2 : 0;
        const recent24h = mems.filter((m) => Number(m.lastActivatedAt) >= now - 86400000).length;
        const promoted = consolidation ? Number(consolidation.promoted) || 0 : 0;
        const deduped = consolidation ? Number(consolidation.deduped) || 0 : 0;
        const activeCount = Number(stats.active) || 0;
        const archivedCount = Number(stats.archived) || 0;
        const momentum = nodeCount ? Number((((promoted + deduped + archivedCount * 0.2) / Math.max(1, activeCount + archivedCount))).toFixed(3)) : 0;
        const phase = deduped > 0 ? 'PRUNE' : promoted > 0 ? 'GROW' : 'STABLE';
        const kinds = { raw: 0, fact: 0, day: 0, diary: 0, self: 0 };
        for (const m of mems) {
          const tags = Array.isArray(m.tags) ? m.tags.map((t) => String(t).toLowerCase()) : [];
          const cat = String(m.category || '').toLowerCase();
          const k = tags.includes('diary')
            ? 'diary'
            : cat === 'self' || tags.includes('self')
              ? 'self'
              : cat === 'day' || tags.includes('day')
                ? 'day'
                : ['fact', 'preference', 'relationship', 'promise', 'topic', 'profile'].includes(cat)
                  ? 'fact'
                  : 'raw';
          kinds[k] += 1;
        }
        const cfgLimits = (brain && brain.config) || {};
        const capacity = {
          long: { used: Number(stats.byLayer && stats.byLayer.long) || 0, quota: Number(cfgLimits.maxMemoriesLong) || 20000 },
          short: { used: Number(stats.byLayer && stats.byLayer.short) || 0, quota: Number(cfgLimits.maxMemoriesShort) || 5000 },
        };
        const avgStrength = mems.length ? Number((mems.reduce((sum, m) => sum + (Number(m.strength) || 0), 0) / mems.length).toFixed(4)) : 0;
        const recent7d = mems.filter((m) => Number(m.lastActivatedAt) > now - 7 * 86400000).length;
        return json(res, 200, {
          ok: true,
          generatedAt: now,
          nodes,
          links,
          stats: {
            nodes: nodeCount,
            links: linkCount,
            memories: Number(stats.total) || 0,
            long: Number(stats.byLayer && stats.byLayer.long) || 0,
            short: Number(stats.byLayer && stats.byLayer.short) || 0,
            diary: Number(stats.diary) || 0,
            permanent: Number(stats.permanent) || 0,
            active: activeCount,
            archived: archivedCount,
            superseded: Number(stats.superseded) || 0,
            deprioritized: Number(stats.deprioritized) || 0,
            state: stats.state && typeof stats.state === 'object' ? stats.state : null,
            synapses: Number(stats.synapses) || 0,
            strongSynapses: Number(stats.strongSynapses) || 0,
            entities: Number(stats.entities) || 0,
            relations: Number(stats.relations) || 0,
            byTier: stats.byTier && typeof stats.byTier === 'object' ? stats.byTier : {},
            relationGroups: stats.relationGroups && typeof stats.relationGroups === 'object' ? stats.relationGroups : {},
            kinds,
            capacity,
            avgStrength,
            recent7d,
            depthProfiles: Array.isArray(stats.depthProfiles) ? stats.depthProfiles : [],
            density: maxPairs ? Number((linkCount / maxPairs).toFixed(4)) : 0,
            meanSynapse: nodeCount ? Number(((linkCount * 2) / nodeCount).toFixed(2)) : 0,
            activationPaths: mems.reduce((sum, m) => sum + (Number(m.activationCount) || 0), 0),
            workingMemory: { used: Math.min(recent24h, 7), cap: 7, recent24h },
            recent24h,
            evolution: {
              momentum,
              target: activeCount,
              phase,
              promoted,
              deduped,
              keywordCleaned: consolidation ? Number(consolidation.keywordCleaned) || 0 : 0,
              duplicateRate: consolidation ? Number(consolidation.duplicateRate) || 0 : 0,
            },
          },
          consolidation,
        });
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'GET' && pathname === '/api/photo-memory') {
      const qs = new URLSearchParams();
      for (const k of ['key', 'query', 'limit']) {
        const v = url.searchParams.get(k);
        if (v) qs.set(k, v);
      }
      const r = await callBridge('/api/photo-memory' + (qs.toString() ? '?' + qs.toString() : ''));
      return json(res, r.ok ? 200 : (r.status || 502), r.ok ? r.data : { ok: false, message: r.error || '桥接未启动' });
    }
    if (req.method === 'GET' && pathname === '/api/photo-memory/original') {
      const id = String(url.searchParams.get('id') || '').trim();
      if (!id) return json(res, 400, { ok: false, message: 'id 不能为空' });
      const token = consoleTokenValue();
      try {
        const r = await fetch(`http://127.0.0.1:${paths.bridgePort}/api/photo-memory/original?id=${encodeURIComponent(id)}`, {
          headers: token ? { 'x-console-token': token } : {},
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return json(res, r.status === 404 ? 404 : 502, { ok: false, message: r.status === 404 ? '这条照片记忆没有原图' : '桥接未启动' });
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, {
          'content-type': r.headers.get('content-type') || 'image/jpeg',
          'content-length': buf.length,
          'cache-control': 'private, max-age=300',
        });
        return res.end(buf);
      } catch (err) {
        return json(res, 502, { ok: false, message: err.message });
      }
    }
    if (req.method === 'POST' && (pathname === '/api/photo-memory/delete' || pathname === '/api/photo-memory/favorite')) {
      const body = await readBody(req);
      // dryRun 统一走 URL 参数或 body：冒烟测试绝不能真删照片 / 真写会话策略。
      if (dryRun || body?.dryRun) return json(res, 200, { ok: true, dryRun: true });
      const r = await callBridge(pathname.replace('/api/photo-memory', '/api/photo-memory'), 'POST', body);
      if (r.ok) pushLog('memory', `照片记忆：${pathname.endsWith('delete') ? '删除' : '收藏'} ${body?.id || ''}`);
      return json(res, r.ok ? 200 : (r.status || 502), r.ok ? r.data : { ok: false, message: r.error || '桥接未启动' });
    }
    // 按会话的模型覆盖：桥接侧是 state/session-policies.json（只影响 model/强度，
    // 模式仍然全局）。控制台只做薄代理，校验与落盘全在桥接里做。
    if (req.method === 'GET' && pathname === '/api/session-policy') {
      const r = await callBridge('/api/session-policy');
      return json(res, r.ok ? 200 : (r.status || 502), r.ok ? r.data : { ok: false, message: r.error || '桥接未启动' });
    }
    if (req.method === 'POST' && (pathname === '/api/session-policy' || pathname === '/api/session-policy/delete' || pathname === '/api/session-policy/reload')) {
      const body = await readBody(req);
      if (dryRun || body?.dryRun) return json(res, 200, { ok: true, dryRun: true });
      const r = await callBridge(pathname, 'POST', body);
      if (r.ok) {
        if (pathname.endsWith('/reload')) pushLog('policy', '会话策略：已从磁盘重载');
        else if (pathname.endsWith('/delete')) pushLog('policy', `会话策略：清除 ${body?.key || ''}`);
        else pushLog('policy', `会话策略：${body?.key || ''} → ${body?.provider || ''}${body?.provider ? '/' : ''}${body?.model || ''}${body?.reasoningEffort ? ' / ' + body.reasoningEffort : ''}`);
      }
      return json(res, r.ok ? 200 : (r.status || 502), r.ok ? r.data : { ok: false, message: r.error || '桥接未启动' });
    }
    if (req.method === 'GET' && pathname === '/api/memory/events') {
      try {
        const svc = getMemory();
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        return json(res, 200, { ok: true, events: svc.recentEvents({ limit }) });
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'GET' && pathname === '/api/memory/svg') {
      try {
        const svgPath = path.join(getMemory().vaultDir(), '图谱', '记忆大脑.svg');
        if (!fs.existsSync(svgPath)) return json(res, 404, { ok: false, message: '知识图谱还没生成（先点「刷新知识库」）' });
        const buf = fs.readFileSync(svgPath);
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(buf);
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/state') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const raw = {};
        if (body.energy !== undefined) raw.energy = Number(body.energy);
        if (body.mood !== undefined) raw.mood = Number(body.mood);
        if (body.reason !== undefined) raw.reason = String(body.reason).slice(0, 120);
        const r = getMemory().updateState(raw);
        pushLog('memory', `人格状态 → ${r.state.energyWord} / ${r.state.moodWord}`);
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    // v1.5-lite 第二批：自述（只增不改）与人设审批、日层压缩。
    if (req.method === 'GET' && pathname === '/api/memory/self') {
      try {
        return json(res, 200, getMemory().narratives({ limit: 50 }));
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/self') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const r = getMemory().addSelfNarrative({ text: String(body.text || '').slice(0, 600) });
        pushLog('memory', `自述 +1（共 ${r.total} 条）`);
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/persona') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const r = getMemory().setPersona({ text: String(body.text || '').slice(0, 400) });
        pushLog('memory', `人设建议待批准：${String(body.text || '').slice(0, 30)}`);
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/persona/resolve') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const status = String(body.status || '');
        const r = getMemory().resolvePersona({ status, by: 'owner' });
        pushLog('memory', `人设建议已${status === 'approved' ? '批准' : '驳回'}`);
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/day') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const raw = {};
        if (body.date) raw.date = String(body.date).slice(0, 10);
        if (body.force) raw.force = true;
        if (body.dryRun) raw.dryRun = true;
        const r = getMemory().dayDigest(raw);
        if (!r.skipped && !r.dryRun) pushLog('memory', `日层已生成：${r.date}`);
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    // v1.5-lite 第三批：人设锚点 / 在乎的 / 自述回炉。
    if (req.method === 'POST' && pathname === '/api/memory/self/anchor') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const r = getMemory().setAnchor({ text: String(body.text || '').slice(0, 300) });
        pushLog('memory', '人设锚点已更新');
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/value') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const r = getMemory().addValue({ text: String(body.text || '').slice(0, 300) });
        pushLog('memory', `在乎的 +1（共 ${r.total} 条）`);
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/self/digest') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const r = getMemory().selfDigest({ force: body.force === true, dryRun: body.dryRun === true });
        if (!r.skipped && !r.dryRun) pushLog('memory', `自述已回炉：${r.count} 条 → 第 ${r.total} 段`);
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/remember') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const svc = getMemory();
        const raw = { title: String(body.title || '').slice(0, 200), text: String(body.text || '').slice(0, 4000) };
        if (!raw.text) return json(res, 400, { ok: false, message: '记忆内容不能为空' });
        if (body.layer === 'long' || body.layer === 'short') raw.layer = body.layer;
        if (body.category) raw.category = String(body.category);
        if (body.protection !== undefined) raw.protection = Number(body.protection);
        if (Array.isArray(body.keywords)) raw.keywords = body.keywords.map(String).slice(0, 20);
        if (Array.isArray(body.tags)) raw.tags = body.tags.map(String).slice(0, 20);
        raw.source = { kind: 'console', key: 'console', seqs: [] };
        const r = svc.remember(raw);
        pushLog('memory', `新增记忆：${raw.title || raw.text.slice(0, 20)}（${raw.layer || 'long'}）`);
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/pin') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const svc = getMemory();
        const raw = {};
        if (body.id !== undefined) raw.id = String(body.id);
        if (body.query !== undefined) raw.query = String(body.query);
        raw.protection = body.protection === undefined ? 1 : Number(body.protection);
        if (body.note !== undefined) raw.note = String(body.note).slice(0, 200);
        const r = svc.pin(raw);
        pushLog('memory', `记忆 ${r.id} 保护线 → ${r.protection}${r.permanent ? '（永久保留）' : ''}`);
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/touch') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const svc = getMemory();
        const raw = { limit: body.limit === undefined ? 1 : Math.min(10, Math.max(1, Number(body.limit) || 1)) };
        if (Array.isArray(body.ids)) raw.ids = body.ids.map(String).slice(0, 20);
        else if (body.id !== undefined) raw.id = String(body.id);
        if (body.query !== undefined) raw.query = String(body.query);
        const r = svc.touch(raw);
        pushLog('memory', `强化记忆 ${r.touched.length} 条${r.missed.length ? `（${r.missed.length} 条未命中）` : ''}`);
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/update') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        if (!body.id) return json(res, 400, { ok: false, message: '缺少 id' });
        const svc = getMemory();
        const raw = { id: String(body.id) };
        for (const key of ['title', 'text', 'layer', 'category']) {
          if (body[key] !== undefined) raw[key] = String(body[key]);
        }
        if (body.protection !== undefined) raw.protection = Number(body.protection);
        if (body.decayDays !== undefined) raw.decayDays = Number(body.decayDays);
        if (body.resetDecay !== undefined) raw.resetDecay = Boolean(body.resetDecay);
        if (Array.isArray(body.tags)) raw.tags = body.tags.map(String).slice(0, 20);
        if (Array.isArray(body.keywords)) raw.keywords = body.keywords.map(String).slice(0, 20);
        const r = svc.update(raw);
        pushLog('memory', `更新记忆 ${r.id}`);
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/forget') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const svc = getMemory();
        const raw = { mode: body.mode === 'purge' ? 'purge' : 'archive' };
        if (Array.isArray(body.ids)) raw.ids = body.ids.map(String).slice(0, 50);
        else if (body.id !== undefined) raw.id = String(body.id);
        if (body.query !== undefined) raw.query = String(body.query);
        if (body.force !== undefined) raw.force = Boolean(body.force);
        const r = svc.forget(raw);
        pushLog('memory', `遗忘记忆 ${r.forgotten.length} 条（${raw.mode}）`);
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/materialize') {
      try {
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const svc = getMemory();
        const r = svc.materialize();
        pushLog('memory', `衰减已物化：${r.total} 条记忆，清理 ${r.purged} 条`);
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/vault-refresh') {
      try {
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const svc = getMemory();
        const raw = execFileSync(process.execPath, [
          path.join(ROOT, 'scripts', 'memory-vault-refresh.mjs'),
          '--state', STATE_DIR,
          '--vault', svc.vaultDir(),
          '--json',
        ], { encoding: 'utf8', timeout: 120000, windowsHide: true });
        let result = {};
        try {
          result = JSON.parse(String(raw).trim().split(/\r?\n/).filter(Boolean).pop() || '{}');
        } catch { result = { raw: String(raw).slice(-400) }; }
        pushLog('memory', '记忆知识库已刷新（Obsidian vault 重新生成）');
        return json(res, 200, { ok: true, result });
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/open-obsidian') {
      try {
        const body = await readBody(req);
        const file = body.file ? String(body.file) : '';
        const uri = obsidianUri(file);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true, uri });
        const child = spawn('cmd.exe', ['/c', 'start', '', uri], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        pushLog('console', `已打开 Obsidian 记忆库${file ? ` / ${file}` : ''}`);
        return json(res, 200, { ok: true, uri, file });
      } catch (err) { return memoryError(res, err); }
    }

    // ── 成长：情绪 / 自升级提案 / 一个月测试台 ──────────────────────────
    // 设计：情绪只是"此刻心情"（默认 24h 过期）；自升级提案她自己只有建议权，
    // 批准权在主人；测试台只记录和度量，不改行为。任何后端缺失都走 memoryError，不崩。
    if (req.method === 'GET' && pathname === '/api/memory/emotion') {
      try {
        return json(res, 200, callMemory('emotion'));
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/emotion') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const raw = {};
        if (body.label !== undefined) raw.label = String(body.label).slice(0, 20);
        if (body.intensity !== undefined) raw.intensity = Number(body.intensity);
        if (body.note !== undefined) raw.note = String(body.note).slice(0, 120);
        if (body.ttlHours !== undefined) raw.ttlHours = Number(body.ttlHours);
        const r = callMemory('setEmotion', raw);
        const emo = r && r.emotion ? r.emotion : null;
        if (emo) {
          const pct = Math.round((Number(emo.intensity) || 0) * 100);
          pushLog('memory', `此刻情绪 → ${emo.label}（强度 ${pct}%，${Number(emo.expiresAt) ? `${Math.max(1, Math.round((Number(emo.expiresAt) - Date.now()) / 3600000))} 小时后过期` : '默认 24h 过期'}）`);
        }
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'GET' && pathname === '/api/memory/proposals') {
      try {
        return json(res, 200, callMemory('proposals'));
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'POST' && pathname === '/api/memory/proposals/decide') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const id = String(body.id || '');
        if (!id) return json(res, 400, { ok: false, code: 'BAD_ARGS', message: '缺少提案 id' });
        const status = String(body.status || '');
        if (status !== 'approved' && status !== 'rejected') {
          return json(res, 400, { ok: false, code: 'BAD_ARGS', message: 'status 只能是 approved 或 rejected' });
        }
        const raw = { id, status, by: 'owner' };
        if (body.reason !== undefined) raw.reason = String(body.reason).slice(0, 300);
        const r = callMemory('resolveProposal', raw);
        pushLog('memory', `自升级提案${status === 'approved' ? '已批准' : '已驳回'}：${id}`);
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'GET' && pathname === '/api/memory/trial') {
      try {
        return json(res, 200, callMemory('trialInfo'));
      } catch (err) { return memoryError(res, err); }
    }

    if (req.method === 'GET' && pathname === '/api/lifelog') {
      const dir = path.join(STATE_DIR, 'life-log');
      const d = new Date();
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const file = path.join(dir, `${dateKey}.jsonl`);
      const enabled = !fs.existsSync(path.join(dir, 'disabled'));
      const samples = [];
      try {
        if (fs.existsSync(file)) {
          for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line || line.startsWith('#')) continue;
            try { samples.push(JSON.parse(line)); } catch {}
          }
        }
      } catch {}
      const summary = summarizeSamples(samples);
      return json(res, 200, { ok: true, enabled, date: dateKey, file, sampleCount: samples.length, summary, text: formatLifeHint(summary) });
    }

    if (req.method === 'POST' && pathname === '/api/lifelog/toggle') {
      const body = await readBody(req);
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, enabled: body.enabled !== false });
      const dir = path.join(STATE_DIR, 'life-log');
      fs.mkdirSync(dir, { recursive: true });
      const flag = path.join(dir, 'disabled');
      if (body.enabled === false) {
        fs.writeFileSync(flag, new Date().toISOString(), 'utf8');
        pushLog('memory', '日常采样已暂停（不再写新的前台程序记录）');
        return json(res, 200, { ok: true, enabled: false });
      }
      try { fs.unlinkSync(flag); } catch {}
      pushLog('memory', '日常采样已开启（每 5 分钟记前台程序+时段，不读标题/不截图）');
      return json(res, 200, { ok: true, enabled: true });
    }

    if (req.method === 'POST' && pathname === '/api/lifelog/sample') {
      try { execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'life-log-sample.mjs')], { timeout: 25000, windowsHide: true }); } catch (err) { return json(res, 500, { ok: false, message: String(err.message || err) }); }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/memory/trial/init') {
      try {
        const body = await readBody(req);
        if (dryRun) return json(res, 200, { ok: true, dryRun: true });
        const raw = {};
        if (body.durationDays !== undefined) raw.durationDays = Number(body.durationDays);
        const svc = getMemory();
        const r = typeof svc.trialInit === 'function' ? svc.trialInit(raw) : initMemoryTrial(raw);
        const days = Number(r && r.trial && r.trial.durationDays) || 30;
        pushLog('memory', `一个月测试台已启动（${days} 天，开封探针「你在开封」）`);
        return json(res, 200, r);
      } catch (err) { return memoryError(res, err); }
    }

    json(res, 404, { ok: false, message: 'not found' });
  } catch (err) {
    pushLog('console', `接口异常 ${pathname}：${err.message}`, 'error');
    json(res, 500, { ok: false, message: err.message });
  }
});

// ---------------------------------------------------------------- 启动

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log(`  统一控制台已在运行：http://127.0.0.1:${paths.port}`);
    console.log('  （端口被占用；如需换端口，用 --port 7789 或环境变量 QQB_CONSOLE_PORT）');
    console.log('');
    process.exit(0);
  }
  console.error('统一控制台启动失败：', err.message);
  process.exit(1);
});

server.listen(paths.port, '127.0.0.1', () => {
  pushLog('console', `统一控制台已启动：http://127.0.0.1:${paths.port}（v${CONSOLE_VERSION}）`);
  pushLog('console', IS_ELEVATED ? '控制台以管理员权限运行' : '控制台以普通权限运行（需要管理员操作时运行 scripts\\enable-admin-mode.ps1）');
  pushLog('console', `项目目录 ${ROOT}`);
  try {
    const check = readConfigSafe();
    if (check.ok) {
      const schema = validateConfig(check.cfg, readJsonFileSafe(CONFIG_EXAMPLE_PATH));
      if (schema.warnings.length) {
        pushLog('console', `配置校验：${schema.warnings.length} 条警告（node scripts/validate-config.mjs 查看）`, 'warn');
      }
    }
  } catch { /* 校验失败不影响控制台启动 */ }
  // 自愈守护必须等 listen 成功之后再起：启动阶段（端口占用、配置错误）不该去拉服务，
  // 手动「全部启动」进行中也会通过 lifecycleDepth 让自愈自动让路。
  startAutoHealGuard();
  startLifeLogGuard();
  // Docker 后端：把已运行容器的日志接进控制台（重启后也能立刻看到 NapCat 的行）
  if (napcatMode() === 'docker') setTimeout(() => ensureNapcatDockerLogStream(), 3000);
  console.log('');
  console.log('==============================================');
  console.log(`  QQ Bridge 统一控制台 v${CONSOLE_VERSION}`);
  console.log('==============================================');
  console.log(`  地址      : http://127.0.0.1:${paths.port}`);
  console.log(`  项目目录  : ${ROOT}`);
  console.log(`  桥接端口  : ${paths.bridgePort}     DSH: ${paths.dshBase}`);
  const napcatModeLabel = { framework: 'Framework 注入', docker: 'Docker 容器', shell: 'Shell' }[napcatMode()] || 'Shell';
  console.log(`  NapCat    : ${paths.napcatDir}  (QQ ${paths.napcatQQ}，模式 ${napcatModeLabel})`);
  console.log(`  自愈守护  : ${autoHealEnabled(paths.unified) ? '开（每 30s 检查，失败冷却 90s）' : '关（unifiedConsole.autoHeal=false）'}`);
  console.log('  服务 / 日志 / 会话 / 人格 / 白名单 / 直连 API / token 花费 / 诊断 / 备份');
  console.log('==============================================');
  console.log('');
});

// 日志 tail：桥接/活动/tool 日志文件 1 秒读一次新增内容
// 2026-11-12：原来 catch 里直接吞掉异常，一旦 tail 整体抛错就永久静默——
// 「实时日志」里只剩 console/napcat 两种来源，文件型日志（bridge/dsh/tool）全空，
// 而且没有任何提示。改成首次失败记一行，便于定位。
let tailErrorLogged = false;
setInterval(() => {
  try { tailAll(); } catch (error) {
    if (!tailErrorLogged) {
      tailErrorLogged = true;
      pushLog('console', `日志 tail 失败（后续静默）：${error?.message ?? error}`, 'warn');
    }
  }
}, 1000);
// 状态 6 秒刷一次（端口探活 + netstat + PowerShell 进程信息，都有缓存）
setInterval(() => { broadcastStatus().catch(() => {}); }, 6000);
// 路由链巡检：8 秒读一次桥接日志新增行，主模型失败自动换池、冷却后回主模型
setInterval(() => { chainTick().catch(() => {}); }, 8000);
// 余额 5 分钟、token 30 秒刷新一次缓存（供状态卡使用）
setInterval(() => { fetchBalance({}).catch(() => {}); }, 5 * 60_000);
// 启动后立刻算一次额度：/api/status 首屏就不会显示「点击刷新」（池积分是异步读的，慢一点到也无所谓）
setTimeout(() => { fetchBalance({}).catch(() => {}); }, 2000);
setInterval(() => { tokenSummary({ force: true }).catch(() => {}); }, 30_000);

process.on('SIGINT', () => {
  pushLog('console', '统一控制台退出（不会自动停服务）');
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  console.error('控制台未捕获异常：', err?.stack || err?.message || err);
  pushLog('console', `控制台未捕获异常：${err?.message || err}`, 'error');
});
process.on('unhandledRejection', (err) => {
  pushLog('console', `控制台未处理的 Promise 拒绝：${err?.message || err}`, 'error');
});














