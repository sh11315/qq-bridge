<#
.SYNOPSIS
  把统一控制台从 Framework 模式切到 Docker 模式（改 config.json 的 unifiedConsole，热加载）。

.DESCRIPTION
  前提：Docker 容器里的 NapCat 已经登录成功（3001 可连，先跑 verify-napcat-docker.ps1 全绿）。
  做的事：
    1) 备份 config.json 到 backups\<时间戳>-switch-docker\；
    2) 把 unifiedConsole.napcatDir 指向 napcat\docker，并写 napcatRunner="docker"
       （compose.yaml 存在时也会自动识别，写显式值是为了让意图清楚）；
    3) 控制台 7788 在跑 → 调 POST /api/config/raw 热加载（控制台里 paths = runtimePaths()，
       不用重启控制台，也不会带走桥接/DSH）；不在跑 → 只改文件，下次启动生效；
    4) 打印切换后的状态（mode 应为 docker）。

  安全注意：
    · 如果当前是 Framework 模式且 NapCat 还在跑（3001 是 QQ.exe），请先在控制台点“停止 NapCat”
      （或 POST /api/service/napcat/stop）再切，否则状态会短暂显示 docker 但 3001 其实是旧 QQ，
      按 docker 停止时不会杀它，容易误判。脚本会检测并提示。
    · Docker 模式下停止 NapCat = docker compose stop，**不会**去杀 3001 的监听进程
      （那是 Docker 的端口转发进程，杀了会把 Docker 打挂）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\napcat-docker-switch.ps1
#>
[CmdletBinding()]
param(
  [switch]$Force   # 检测到 Framework 的 QQ 还占着 3001 时也强行切（不推荐）
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config.json'
$dockerDir = Join-Path $root 'napcat\docker'
$tokenFile = Join-Path $root 'state\console-token'

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }

function Test-Port([int]$Port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(800)) { return $false }
    $client.EndConnect($iar); return $true
  } catch { return $false } finally { $client.Close() }
}

function Read-Config {
  $raw = [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
  return $raw | ConvertFrom-Json
}

function Get-CurrentRunner {
  $cfg = Read-Config
  $dir = [string]$cfg.unifiedConsole.napcatDir
  if ($dir -and (Test-Path (Join-Path $dir 'compose.yaml'))) { return 'docker' }
  if ($dir -and (Test-Path (Join-Path $dir 'napiLoader.bat'))) { return 'framework' }
  return 'shell'
}

# 0. 前置：容器确实登录了
if (-not (Test-Path (Join-Path $dockerDir 'compose.yaml'))) { Say "[x] 找不到 $dockerDir\compose.yaml" 'Red'; exit 1 }
if (-not (Test-Port 3001)) {
  Say '[x] 3001 不通：Docker 里的 NapCat 还没起来/还没登录。先跑 scripts\napcat-docker-start.ps1 -WaitLogin' 'Red'
  exit 1
}
$login = $null
try {
  $login = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/get_login_info' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 8
} catch { }
if (-not ($login -and $login.status -eq 'ok')) {
  Say '[x] OneBot 3000 的 get_login_info 不通：先确认容器已登录（verify-napcat-docker.ps1）' 'Red'
  if (-not $Force) { exit 1 }
}

# 1. 现在是谁占着 3001？
$current = Get-CurrentRunner
$holders = @()
try {
  $holders = Get-NetTCPConnection -State Listen -LocalPort 3001 -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue | Select-Object Id, ProcessName }
} catch { }
$holderText = ($holders | ForEach-Object { "$($_.ProcessName)#$($_.Id)" }) -join ','
Say ("当前模式：$current；3001 监听者：$holderText")

if ($current -eq 'docker' -and $holderText -match 'QQ|node') {
  Say '[x] 3001 被本机 QQ/node 占着，说明 Docker 没在跑（或端口冲突）。先停掉旧的 NapCat 再来。' 'Red'
  if (-not $Force) { exit 1 }
}
if ($current -eq 'framework' -and $holderText -match 'QQ') {
  Say '[!] 3001 现在被 Framework 的 QQ.exe 占着。切到 Docker 前请先停旧 NapCat：' 'Yellow'
  Say '    POST http://127.0.0.1:7788/api/service/napcat/stop （或控制台点“停止 NapCat”）' 'Yellow'
  if (-not $Force) { exit 1 }
}

# 2. 备份 + 改配置
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $root "backups\$stamp-switch-docker"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item $configPath (Join-Path $backupDir 'config.json') -Force
Say ("已备份：$backupDir")

$cfg = Read-Config
if (-not $cfg.unifiedConsole) { $cfg.unifiedConsole = [pscustomobject]@{} }

# 用 node 改 JSON：PowerShell 5.1 的 ConvertTo-Json 会把中文转成 \uXXXX，读起来一塌糊涂
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node -and (Test-Path 'D:\node.exe')) { $node = 'D:\node.exe' }
if ($node) {
  $tmp = Join-Path $env:TEMP ('switch-docker-' + [guid]::NewGuid().ToString('N') + '.cjs')
  @'
const fs = require('fs');
const [p, dir] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
cfg.unifiedConsole = cfg.unifiedConsole || {};
cfg.unifiedConsole.napcatDir = dir;
cfg.unifiedConsole.napcatRunner = 'docker';
fs.writeFileSync(p, JSON.stringify(cfg, null, 4) + '\n', 'utf8');
'@ | Set-Content -Path $tmp -Encoding UTF8
  & $node $tmp $configPath $dockerDir
  $nodeExit = $LASTEXITCODE
  Remove-Item $tmp -ErrorAction SilentlyContinue
  if ($nodeExit -ne 0) { Say '[x] node 改配置失败' 'Red'; exit 1 }
} else {
  $cfg.unifiedConsole | Add-Member -NotePropertyName napcatDir -NotePropertyValue $dockerDir -Force
  $cfg.unifiedConsole | Add-Member -NotePropertyName napcatRunner -NotePropertyValue 'docker' -Force
  $json0 = $cfg | ConvertTo-Json -Depth 100
  [IO.File]::WriteAllText($configPath, $json0, (New-Object System.Text.UTF8Encoding($false)))
}
$json = [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8)
Say ("已写入 config.json：napcatDir=$dockerDir，napcatRunner=docker")

# 3. 控制台在跑就热加载（POST /api/config/raw 会 paths = runtimePaths()）
if (Test-Port 7788 -and (Test-Path $tokenFile)) {
  $token = (Get-Content $tokenFile -Raw).Trim()
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:7788/api/config/raw' -Method Post `
      -Headers @{ 'x-console-token' = $token } -ContentType 'application/json' `
      -Body (@{ raw = $json } | ConvertTo-Json -Compress) -TimeoutSec 20
    if ($r.ok) {
      Say '[ok] 控制台已热加载新配置（无需重启控制台，桥接/DSH 不受影响）' 'Green'
    } else {
      Say ('[!] 热加载失败：' + ($r.message | Out-String)) 'Yellow'
    }
  } catch {
    Say ('[!] 热加载失败（' + $_.Exception.Message + '）：重启控制台后生效') 'Yellow'
  }
  Start-Sleep -Seconds 1
  try {
    $st = Invoke-RestMethod -Uri 'http://127.0.0.1:7788/api/status' -Method Get -Headers @{ 'x-console-token' = $token } -TimeoutSec 10
    Say ("控制台 NapCat：mode=$($st.services.napcat.mode) up=$($st.services.napcat.up) ws=$($st.services.napcat.wsConnected) online=$($st.services.napcat.accountOnline)") 'Cyan'
    if ($st.services.napcat.mode -ne 'docker') {
      Say '[!] 控制台还没切成 docker：确认控制台版本已含 2026-10-25 的 Docker 补丁，或重启一次控制台。' 'Yellow'
    }
  } catch { }
} else {
  Say '控制台 7788 没在跑：配置已改好，下次启动控制台即为 Docker 模式。'
}

Say ''
Say '下一步：' 'Cyan'
Say '  · NapCat 已在容器里跑（3001 可连），如果桥接没起：POST /api/start 或控制台“全部启动”'
Say '  · 日常停止/启动 NapCat 都用控制台按钮；Docker 模式下它们走 docker compose，不会杀错进程'
Say '  · 回滚：把 backups\<时间戳>-switch-docker\config.json 覆盖回去（或再跑本脚本前先备份的那份），重启控制台'
