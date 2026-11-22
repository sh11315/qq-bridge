#!/usr/bin/env node
/**
 * 全栈看门狗（独立于控制台进程）。
 *
 * 为什么要有这个脚本：
 *   以前「谁还活着」的检查都长在 console/server.mjs 里。控制台自己崩掉（或
 *   2026-11-02 那种 NapCat 容器 OOM 137 引发的连锁）时，没有任何进程去把它拉起来，
 *   三层（Docker ← NapCat → 桥接 → 控制台）就成了单点：一层死、全栈躺平。
 *   这个脚本由 Windows 计划任务每 3 分钟跑一次，只做最保守的三件事：
 *     1) 3100 端口不通且没有存活的 bridge 进程 → 调 start.bat（它自带退出重拉循环）；
 *     2) 7788 端口不通 → 调 start-console.bat；
 *     3) 3001（OneBot）不通 → docker start napcat-qq（必要时先拉起 Docker Desktop）。
 *   端口通就什么都不做；不做 kill、不动 DSH、不碰 QQ 会话，避免"看门狗自己变成故障源"。
 *
 * 用法：
 *   node scripts/watchdog-stack.mjs            # 正常运行（计划任务用）
 *   node scripts/watchdog-stack.mjs --dry-run  # 只打印将要做什么
 *   node scripts/watchdog-stack.mjs --verbose  # 每次运行都打一行状态
 *
 * 日志：state/watchdog.log（自动按行裁剪），冷却状态：state/watchdog-state.json
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE_DIR = path.join(ROOT, 'state');
const LOG_FILE = path.join(STATE_DIR, 'watchdog.log');
const STATE_FILE = path.join(STATE_DIR, 'watchdog-state.json');
const LOCK_FILE = path.join(STATE_DIR, 'watchdog.lock');
const LOG_MAX_LINES = 400;
/** 同一服务的重启冷却：避免桥接启动慢时每 3 分钟又叠一个新实例。 */
const COOLDOWN_MS = 5 * 60 * 1000;
const PORT_TIMEOUT_MS = 2500;

const dryRun = process.argv.includes('--dry-run');
const verbose = process.argv.includes('--verbose');

function ensureStateDir() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* 已存在 */ }
}

function nowText() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function logLine(text) {
  const line = `[${nowText()}] ${text}`;
  try {
    ensureStateDir();
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
    // 裁剪：只在文件偏大时做，避免每次运行都读写整个文件。
    const st = fs.statSync(LOG_FILE);
    if (st.size > 256 * 1024) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
      fs.writeFileSync(LOG_FILE, lines.slice(-LOG_MAX_LINES).join('\n'), 'utf8');
    }
  } catch { /* 日志失败不影响自愈 */ }
}

function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (value && typeof value === 'object') return value;
  } catch { /* 首次运行 / 损坏都当空状态 */ }
  return {};
}

function writeState(value) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(value, null, 2), 'utf8'); } catch { /* 忽略 */ }
}

function portOpen(port, timeoutMs = PORT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try { socket.connect(port, '127.0.0.1'); } catch { done(false); }
  });
}

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 读 state/bridge.lock 里的 PID（重启脚本写的那个），用来区分「端口没开但进程还活着（启动中）」与「真死了」。 */
function bridgePid() {
  try {
    const raw = fs.readFileSync(path.join(STATE_DIR, 'bridge.lock'), 'utf8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch { return 0; }
}

/** 拉起一个批处理（脱离本进程，看门狗退出后它继续活着）。 */
function launchBatch(file, extraArgs = []) {
  const target = path.join(ROOT, file);
  if (!fs.existsSync(target)) return { ok: false, error: `找不到 ${file}` };
  if (dryRun) return { ok: true, dryRun: true };
  const child = spawn('cmd.exe', ['/c', 'start', '', '/b', target, ...extraArgs], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { ok: true };
}

function dockerExe() {
  const candidates = [
    'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
  ];
  for (const file of candidates) {
    try { if (fs.existsSync(file)) return file; } catch { /* 下一个 */ }
  }
  return 'docker';
}

function desktopExe() {
  const file = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe');
  try { return fs.existsSync(file) ? file : ''; } catch { return ''; }
}

function runDocker(args, timeoutMs) {
  return new Promise((resolve) => {
    if (dryRun) { resolve({ ok: true, dryRun: true, stdout: '' }); return; }
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(dockerExe(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ ok: false, error: error?.message ?? String(error) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ ok: false, error: `docker ${args.join(' ')} 超时` });
    }, timeoutMs || 60000);
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.stderr?.on('data', (chunk) => { err += chunk; });
    child.once('error', (error) => { clearTimeout(timer); resolve({ ok: false, error: error?.message ?? String(error) }); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: out.trim(), error: code === 0 ? '' : (err.trim() || `exit ${code}`) });
    });
  });
}

async function ensureNapcat() {
  const up = await portOpen(3001);
  if (up) return { name: 'napcat', ok: true, state: 'up' };
  // OneBot 没监听：先问 Docker 容器在不在跑。
  const ps = await runDocker(['ps', '--filter', 'name=napcat-qq', '--format', '{{.Names}}'], 20000);
  if (ps.ok && /napcat-qq/.test(ps.stdout)) {
    // 容器在跑但 3001 没起来：可能正在重连/重登，别急着重启，记一笔等下一轮（容器内部问题）。
    return { name: 'napcat', ok: false, state: 'container-up-but-port-down' };
  }
  if (!ps.ok) {
    // docker 命令失败：daemon 不在 → 拉起 Docker Desktop，容器由 restart 策略自己回来。
    const desktop = desktopExe();
    if (desktop && !dryRun) {
      try { spawn(desktop, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref(); } catch { /* 忽略 */ }
    }
    return { name: 'napcat', ok: false, state: 'docker-down', action: desktop ? '启动 Docker Desktop' : 'docker 不可用' };
  }
  const started = await runDocker(['start', 'napcat-qq'], 60000);
  return { name: 'napcat', ok: started.ok, state: started.ok ? 'started' : 'start-failed', error: started.error || '' };
}

function cooldownOk(state, name) {
  const last = Number(state?.[name] ?? 0);
  return !last || Date.now() - last > COOLDOWN_MS;
}

function withinLock() {
  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    const pid = Number(raw);
    if (pidAlive(pid)) return true; // 上一轮还在跑
  } catch { /* 没有锁 */ }
  try { fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8'); } catch { /* 忽略 */ }
  return false;
}

function releaseLock() {
  try {
    if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK_FILE);
  } catch { /* 忽略 */ }
}

async function main() {
  if (withinLock()) {
    if (verbose) logLine('上一轮看门狗仍在运行，本轮跳过');
    return;
  }
  try {
    const state = readState();
    const actions = [];

    // ① 桥接 3100：端口不通才管；进程仍在（启动中）就等下一轮。
    if (!(await portOpen(3100))) {
      const pid = bridgePid();
      if (pidAlive(pid)) {
        actions.push({ name: 'bridge', state: 'starting', detail: `进程 ${pid} 存活但端口未开，等待` });
      } else if (!cooldownOk(state, 'bridge')) {
        actions.push({ name: 'bridge', state: 'down', detail: '冷却中，本轮不重复拉起' });
      } else {
        const r = launchBatch('start.bat');
        state.bridge = Date.now();
        actions.push({ name: 'bridge', state: r.ok ? 'restarted' : 'restart-failed', detail: r.error || '' });
      }
    }

    // ② 控制台 7788：它没有自愈循环，死了就是死了。
    if (!(await portOpen(7788))) {
      if (!cooldownOk(state, 'console')) {
        actions.push({ name: 'console', state: 'down', detail: '冷却中，本轮不重复拉起' });
      } else {
        const r = launchBatch('start-console.bat');
        state.console = Date.now();
        actions.push({ name: 'console', state: r.ok ? 'restarted' : 'restart-failed', detail: r.error || '' });
      }
    }

    // ③ NapCat 3001：容器在跑但端口不通属于「容器内部重连」，只记日志不重启。
    let napcatResult = { name: 'napcat', ok: true, state: 'up' };
    if (!(await portOpen(3001))) {
      if (!cooldownOk(state, 'napcat')) {
        napcatResult = { name: 'napcat', state: 'down', hint: '冷却中，本轮不重复拉起' };
      } else {
        napcatResult = await ensureNapcat();
        state.napcat = Date.now();
      }
    }
    if (napcatResult.state !== 'up') actions.push(napcatResult);

    writeState(state);

    const interesting = actions.filter((a) => a.state !== 'up');
    if (interesting.length > 0 || verbose) {
      const text = (interesting.length > 0 ? interesting : [{ name: 'stack', state: 'ok' }])
        .map((a) => `${a.name}:${a.state}${a.detail ? `（${a.detail}）` : ''}${a.hint ? `（${a.hint}）` : ''}`)
        .join('；');
      logLine(text);
      if (!verbose) process.stdout.write(`[watchdog] ${text}\n`);
    }
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  logLine(`看门狗自身异常：${error?.message ?? error}`);
  process.exitCode = 1;
});
