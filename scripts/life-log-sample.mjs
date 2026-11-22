// 每 5 分钟采一次「前台程序 + 空闲秒数」，只写粗粒度分类。
//
// 默认不读窗口标题、不截图、不记录键盘内容；密码管理器归类为 private 且不写进程名。
// 2026-10-31 03:0x owner 说「设置成完全查看」——加了一档 full：
//   建 state/life-log/full 文件后，采样会额外读窗口标题（截断 80 字）并记进当天 jsonl，
//   用来知道「他在看什么/写什么」；private 类（密码管理器等）和标题里带敏感词的仍然只留分类。
//   仍然不截图、不记录键鼠内容。
// 关闭方式：控制台成长页关掉开关，或直接创建 state/life-log/disabled 文件。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { categoryOfProcess } from '../src/core/life-log.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(REPO_ROOT, 'state', 'life-log');
const DISABLED_FILE = path.join(LOG_DIR, 'disabled');
const FULL_FILE = path.join(LOG_DIR, 'full');
const KEEP_DAYS = 60;

// 标题里出现这些词就只留分类，不进日志（账号、隐私、支付这类）。
const SENSITIVE_TITLE_RE = /(密码|登录|账号|帐号|验证码|支付|银行|钱包|私钥|token|login|sign in|password|bank)/i;

const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// 2026-10-31 14:1x：这台机器上 Add-Type 会报「A required privilege is not held by the client」
// （csc 编译需要提权/受限令牌里跑不起来），P/Invoke 取前台窗口这条路整条挂掉，
// 于是采样一直静默返回空值、日志从 01:26 起就断了。改成两条腿：
//   ① 能 Add-Type 就照旧取前台窗口 + 空闲秒数；
//   ② 不能就退化成「列出带标题的窗口」（proc + title 对），不再依赖任何编译。
// 退化模式下 idle 没有可靠来源，记 -1 表示「未知」，读的时候别当真。
const PS = `
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$ok = $false
try { Add-Type -TypeDefinition 'using System;
using System.Runtime.InteropServices;
using System.Text;
public class LL {
  [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(System.IntPtr h, StringBuilder s, int max);
  [DllImport("kernel32.dll")] public static extern uint GetTickCount();
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
}' -ErrorAction Stop; $ok = $true } catch {}
if ($ok) {
$h = [LL]::GetForegroundWindow()
$procId = 0
[void][LL]::GetWindowThreadProcessId($h, [ref]$procId)
$name = ''
if ($procId -gt 0) {
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($p) { $name = $p.ProcessName }
}
$title = ''
if ($h -ne [System.IntPtr]::Zero) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][LL]::GetWindowTextW($h, $sb, 512)
  $title = $sb.ToString()
}
$li = New-Object LL+LASTINPUTINFO
$li.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($li)
[void][LL]::GetLastInputInfo([ref]$li)
$delta = [int64][LL]::GetTickCount() - [int64]$li.dwTime
if ($delta -lt 0) { $delta += 4294967296 }
ConvertTo-Json -Compress -InputObject @{ proc = $name; idle = [int64][math]::Floor($delta / 1000); title = $title }
} else {
  # 退化模式：不编译、不 P/Invoke，只罗列带标题的窗口。
  $list = @()
  foreach ($p in (Get-Process | Where-Object { $_.MainWindowTitle })) {
    $list += @{ proc = $p.ProcessName; title = [string]$p.MainWindowTitle }
    if ($list.Count -ge 8) { break }
  }
  ConvertTo-Json -Compress -InputObject @{ proc = ''; idle = -1; title = ''; windows = $list }
}
`;

function main() {
  if (fs.existsSync(DISABLED_FILE)) return;
  let info = { proc: '', idle: 0 };
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    }).trim();
    if (out) info = JSON.parse(out);
  } catch (err) {
    // 采样失败不写脏数据；把原因留在当天日志的注释行（纯文本行，读的时候会跳过）。
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(path.join(LOG_DIR, `${dateKey()}.jsonl`), `# ${new Date().toISOString()} sample-failed ${String(err.message || err).slice(0, 120)}\n`, 'utf8');
    } catch {}
    return;
  }
  const proc = String(info.proc || '').trim();
  const windows = Array.isArray(info.windows) ? info.windows : [];
  const full = fs.existsSync(FULL_FILE);
  const cleanTitle = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  let entry = null;
  if (!proc && windows.length) {
    // 退化模式：没有前台窗口信息，就记「现在挂着的窗口」——proc + 标题成对。
    const rows = [];
    for (const win of windows) {
      const name = String(win?.proc || '').trim();
      if (!name) continue;
      const cat = categoryOfProcess(name);
      if (cat === 'private') continue;
      const title = cleanTitle(win?.title);
      if (full && title && SENSITIVE_TITLE_RE.test(title)) continue;
      rows.push({ proc: name, cat, ...(full && title ? { title } : {}) });
      if (rows.length >= 6) break;
    }
    if (!rows.length) return;
    entry = { at: Date.now(), proc: '', cat: rows[0].cat, idle: -1, windows: rows };
  } else {
    if (!proc) return;
    const cat = categoryOfProcess(proc);
    // full 档才留标题：private 类、以及标题命中敏感词的，一律只留分类。
    const title = cleanTitle(info.title);
    const keepTitle = full && cat !== 'private' && title && !SENSITIVE_TITLE_RE.test(title);
    entry = {
      at: Date.now(),
      proc: cat === 'private' ? '' : proc,
      cat,
      idle: Number(info.idle) || 0,
      ...(keepTitle ? { title } : {}),
    };
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, `${dateKey()}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8');

  // 清理过期日志（默认保留 60 天）
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    for (const name of fs.readdirSync(LOG_DIR)) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      const full = path.join(LOG_DIR, name);
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch {}
}

main();
