<#
.SYNOPSIS
  NapCat Docker 一键验收：容器、3000/3001/6099、登录态、WebSocket、桥接连通、控制台模式。

.DESCRIPTION
  逐项检查并打印 [PASS]/[FAIL]/[WARN]，最后给出答案：
    · 容器 running、端口监听（3000/3001/6099，监听者是 Docker 的转发进程）
    · /get_login_info 返回 100000002（用 HTTP 3000）
    · ws://127.0.0.1:3001 能收到事件（用 node 内置 WebSocket 实测，不是只看端口）
    · 二维码 PNG 是否已生成（未登录时）
    · 控制台 /api/status：mode=docker、桥接 wsConnected/accountOnline
  退出码：0 全通过；1 有失败项。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-napcat-docker.ps1
#>
[CmdletBinding()]
param([switch]$Quiet)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $root 'napcat\docker\compose.yaml'
$qrFile = Join-Path $root 'state\napcat-docker-qr.png'
$fail = 0
$warn = 0

function Item([string]$name, [bool]$ok, [string]$detail = '', [switch]$IsWarn) {
  if ($ok) {
    if (-not $Quiet) { Write-Host ('[PASS] ' + $name + $(if ($detail) { ' —— ' + $detail } else { '' })) -ForegroundColor Green }
  } elseif ($IsWarn) {
    $script:warn++
    Write-Host ('[WARN] ' + $name + ' —— ' + $detail) -ForegroundColor Yellow
  } else {
    $script:fail++
    Write-Host ('[FAIL] ' + $name + ' —— ' + $detail) -ForegroundColor Red
  }
}

function Test-Port([int]$Port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(800)) { return $false }
    $client.EndConnect($iar); return $true
  } catch { return $false } finally { $client.Close() }
}

Write-Host '===== NapCat Docker 验收 =====' -ForegroundColor Cyan

# 1. docker
$docker = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
if (-not (Test-Path $docker)) {
  $cmd = Get-Command docker.exe -ErrorAction SilentlyContinue
  $docker = if ($cmd) { $cmd.Source } else { '' }
}
Item 'docker 命令' ([bool]$docker) $(if ($docker) { $docker } else { '未装 Docker Desktop' })
if (-not $docker) { Write-Host "结论：Docker 没装，先跑 scripts\napcat-docker-install.ps1 并重启。" -ForegroundColor Red; exit 1 }

$ver = (& $docker version --format '{{.Server.Version}}' 2>&1 | Out-String).Trim()
Item 'Docker daemon 可用' ($LASTEXITCODE -eq 0) $ver

# 2. 容器
$state = (& $docker inspect -f '{{.State.Status}}' napcat-qq 2>&1 | Out-String).Trim()
Item '容器 napcat-qq 运行中' ($state -eq 'running') ("state=" + $state)

# 3. 端口
$ports = @{
  3000 = 'OneBot HTTP'
  3001 = 'OneBot WebSocket'
  6099 = 'NapCat WebUI'
}
foreach ($p in $ports.Keys | Sort-Object) {
  $ok = Test-Port $p
  $owners = @()
  try {
    $owners = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName }
  } catch { }
  Item ("端口 $p（$($ports[$p])）") $ok (($owners | Where-Object { $_ }) -join ',')
}

# 4. 登录态
$login = $null
try {
  $login = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/get_login_info' -Method Post `
    -ContentType 'application/json' -Body '{}' -TimeoutSec 8
} catch { }
$loggedIn = ($login -and $login.status -eq 'ok' -and $login.data)
$who = if ($loggedIn) { "$($login.data.nickname)（$($login.data.user_id)）" } else { [string]$_.Exception.Message }
Item 'OneBot /get_login_info' ([bool]$loggedIn) $who

if (-not $loggedIn) {
  Item '登录二维码 PNG 已生成' (Test-Path $qrFile) $qrFile -IsWarn
}

# 5. WebSocket 实测（node 内置 WebSocket）
$wsScript = Join-Path $root 'state\_verify-ws.mjs'
@'
const ws = new WebSocket('ws://127.0.0.1:3001');
let got = false;
const timer = setTimeout(() => { console.log(got ? 'WS OK' : 'WS TIMEOUT'); process.exit(got ? 0 : 3); }, 6000);
ws.onmessage = (e) => {
  got = true;
  console.log('WS EVENT ' + String(e.data).slice(0, 300));
  clearTimeout(timer);
  ws.close();
  setTimeout(() => process.exit(0), 150);
};
ws.onerror = () => { console.log('WS ERROR'); clearTimeout(timer); process.exit(2); };
'@ | Set-Content -Path $wsScript -Encoding UTF8
$wsOut = (& 'D:\node.exe' $wsScript 2>&1 | Out-String).Trim()
Item 'WebSocket 3001 可收发事件' ($LASTEXITCODE -eq 0) $wsOut
Remove-Item $wsScript -ErrorAction SilentlyContinue

# 6. 控制台接线
$tokenFile = Join-Path $root 'state\console-token'
$consoleUp = Test-Port 7788
if ($consoleUp -and (Test-Path $tokenFile)) {
  $token = (Get-Content $tokenFile -Raw).Trim()
  try {
    $status = Invoke-RestMethod -Uri 'http://127.0.0.1:7788/api/status' -Method Get -Headers @{ 'x-console-token' = $token } -TimeoutSec 10
    $nap = $status.services.napcat
    $brg = $status.services.bridge
    Item '控制台 NapCat 模式 = docker' ($nap.mode -eq 'docker') ("mode=" + $nap.mode)
    Item '控制台 NacCat up' ([bool]$nap.up) ("ws=" + $nap.wsConnected + " online=" + $nap.accountOnline)
    Item '桥接 WS 已连接' ([bool]$brg.wsConnected) ("port=" + $brg.port)
  } catch { Item '控制台状态读取' $false $_.Exception.Message }
} else {
  Item '控制台 7788' $false '控制台没在跑（可选检查）' -IsWarn
}

# 7. 结论
Write-Host ''
if ($fail -eq 0) {
  Write-Host ("结论：通过（warn=$warn）。NapCat 在容器里，桥接连 127.0.0.1:3001。") -ForegroundColor Green
  exit 0
}
Write-Host ("结论：$fail 项失败（warn=$warn）。排障：") -ForegroundColor Red
Write-Host ('  ' + $docker + ' compose -f "' + $composeFile + '" logs --tail 120') -ForegroundColor Yellow
Write-Host '  未登录：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\napcat-docker-start.ps1 -WaitLogin'
exit 1
