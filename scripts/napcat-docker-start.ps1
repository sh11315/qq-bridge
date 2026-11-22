<#
.SYNOPSIS
  启动 NapCat Docker 容器，并把登录二维码生成 PNG（不需要管理员权限）。

.DESCRIPTION
  流程：
    1) 找 docker.exe（Docker Desktop 默认装在 C:\Program Files\Docker\Docker\resources\bin）；
    2) `docker info` 不通 → 拉起 Docker Desktop 并最多等 180 秒；
    3) `docker compose -f napcat/docker/compose.yaml up -d` 起容器（首次会拉镜像）；
    4) 等 6099/3001：
       · 3001 通了 = 已登录，直接打印账号并退出 0；
       · 只有 6099 = 未登录 → 通过 WebUI API 取二维码，渲染成 PNG 存到
         state\napcat-docker-qr.png，提示用户用手机 QQ 扫；
    5) 加 -WaitLogin 时会一直等到 3001 通（最长 -LoginTimeoutSec 秒），期间每 90 秒刷新一次二维码。

  二维码内容如果是 https://txz.qq.com/p?k=... 就调用 api.qrserver.com 出图；
  NapCat 万一直接给 base64 图片就原样落盘；都失败时把二维码内容写进同名 .txt 兜底。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\napcat-docker-start.ps1

.EXAMPLE
  # 出码后一直等扫码成功（最多 5 分钟，期间自动换过期码）
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\napcat-docker-start.ps1 -WaitLogin
#>
[CmdletBinding()]
param(
  [string]$OutFile = '',          # 二维码 PNG 路径，默认 <项目根>\state\napcat-docker-qr.png
  [switch]$WaitLogin,             # 出码后等登录成功
  [int]$LoginTimeoutSec = 300,    # -WaitLogin 的最长等待
  [switch]$Refresh,               # 强制刷新一次二维码
  [switch]$NoStart                # 只查状态/出码，不拉起容器
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dockerDir = Join-Path $root 'napcat\docker'
$composeFile = Join-Path $dockerDir 'compose.yaml'
$webuiCfg = Join-Path $dockerDir 'config\webui.json'
if (-not $OutFile) { $OutFile = Join-Path $root 'state\napcat-docker-qr.png' }

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Fail([string]$msg) { Say ('[x] ' + $msg) 'Red'; exit 1 }

function Test-Port {
  param([int]$Port, [int]$TimeoutMs = 800)
  $client = New-Object Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch { return $false } finally { $client.Close() }
}

function Find-Docker {
  $candidates = @(
    'C:\Program Files\Docker\Docker\resources\bin\docker.exe',
    (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe')
  )
  foreach ($f in $candidates) { if (Test-Path $f) { return $f } }
  $cmd = Get-Command docker.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return ''
}

function Find-DockerDesktop {
  $candidates = @(
    'C:\Program Files\Docker\Docker\Docker Desktop.exe',
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')
  )
  foreach ($f in $candidates) { if (Test-Path $f) { return $f } }
  return ''
}

function Test-DockerReady([string]$docker) {
  try {
    & $docker info --format '{{.ServerVersion}}' *> $null
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}

function Wait-DockerReady([string]$docker, [int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-DockerReady $docker) { return $true }
    Start-Sleep -Seconds 3
    Write-Host '.' -NoNewline
  }
  Write-Host ''
  return $false
}

# ---------------------------------------------------------------- 0. 前置检查
Say '===== NapCat Docker 启动 =====' 'Cyan'
if (-not (Test-Path $composeFile)) { Fail "找不到 $composeFile（先跑 node scripts\napcat-docker-prepare.mjs）" }

# WSL2 运行时：安装脚本把这一步留到重启后（重启前 wsl --install 会挂住不返回，实测）
$wslExe = "$env:SystemRoot\System32\wsl.exe"
if (Test-Path $wslExe) {
  $wslOk = $false
  try {
    $wslOut = (& $wslExe --status 2>&1 | Out-String)
    $wslOk = ($LASTEXITCODE -eq 0 -and $wslOut -notmatch '未安装|not installed|无适用于')
  } catch { }
  if (-not $wslOk) {
    Say '[i] WSL2 运行时未就绪：执行 wsl --update（最多等 180 秒；可能要 UAC）…' 'Yellow'
    $wp = $null
    try {
      $wp = Start-Process -FilePath $wslExe -ArgumentList '--update', '--web-download' -PassThru -NoNewWindow
      $wp | Wait-Process -Timeout 180 -ErrorAction Stop
    } catch {
      try { if ($wp) { $wp | Stop-Process -Force } } catch { }
      Say '[!] wsl --update 没在 180 秒内完成（Docker Desktop 首次启动时也会再试）' 'Yellow'
      Say '    若一直不行：用管理员运行  wsl --install --no-distribution （重启后不会再挂），或重跑 napcat-docker-install.ps1' 'Yellow'
    }
    Start-Sleep -Seconds 2
  }
}

$docker = Find-Docker
if (-not $docker) {
  Fail @'
找不到 docker.exe：Docker Desktop 还没装。
  请用户先运行（需要管理员 + 装完要重启）：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\napcat-docker-install.ps1
  重启后再跑本脚本。
'@
}
Say ("docker: " + $docker)

# ---------------------------------------------------------------- 1. 确保 Docker Desktop 在跑
if (-not (Test-DockerReady $docker)) {
  $desktop = Find-DockerDesktop
  if (-not $desktop) { Fail 'docker 命令在，但 Docker Desktop.exe 不存在：请手动启动 Docker Desktop（或重装）' }
  Say 'Docker Desktop 未就绪，正在启动（首次 1~2 分钟，别重复开）…' 'Yellow'
  Start-Process -FilePath $desktop | Out-Null
  Write-Host '  等待 daemon'
  if (-not (Wait-DockerReady $docker 180)) {
    Fail 'Docker Desktop 180 秒内没起来：看任务栏鲸鱼图标（可能要登录账号/接受协议/更新 WSL2/重启电脑）'
  }
}
Say 'Docker daemon 就绪' 'Green'

# ---------------------------------------------------------------- 2. 起容器
if (-not $NoStart) {
  Say 'docker compose up -d …'
  $composeOut = & $docker compose -f $composeFile up -d 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Say $composeOut 'Red'
    Say '[!] compose 失败常见原因：镜像拉不下来（国内网络）→ 给 Docker Desktop 配镜像加速；或 WSL2 没生效 → 重启。' 'Yellow'
    Say ('    看容器日志：' + $docker + ' compose -f "' + $composeFile + '" logs --tail 80')
    exit 2
  }
  ($composeOut.Trim() -split "`r?`n" | Select-Object -Last 4) | ForEach-Object { Say ('  ' + $_) 'DarkGray' }
}

# ---------------------------------------------------------------- 3. 等端口
Say '等待 NapCat 端口（3001 登录后才有；6099 是 WebUI 先起）…'
$wsUp = $false
$webuiUp = $false
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  $webuiUp = Test-Port 6099
  $wsUp = Test-Port 3001
  if ($wsUp) { break }
  if ($webuiUp) { break }
  Start-Sleep -Milliseconds 1500
  Write-Host '.' -NoNewline
}
Write-Host ''

function Get-LoginInfo {
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/get_login_info' -Method Post `
      -ContentType 'application/json' -Body '{}' -TimeoutSec 8
    if ($r.status -eq 'ok' -and $r.data) { return $r.data }
  } catch { }
  return $null
}

if ($wsUp) {
  $info = Get-LoginInfo
  $who = if ($info) { "$($info.nickname)（$($info.user_id)）" } else { '已登录（get_login_info 未返回，不影响）' }
  Say ("[ok] OneBot 3001 已就绪，账号：$who") 'Green'
  Say '容器已登录，无需扫码。'
  exit 0
}

if (-not $webuiUp) {
  Say '[x] 6099/3001 都没起来：容器没跑起来或 NapCat 崩了。' 'Red'
  Say ('    排查：' + $docker + ' ps -a')
  Say ('          ' + $docker + ' compose -f "' + $composeFile + '" logs --tail 100')
  exit 3
}

# ---------------------------------------------------------------- 4. 取二维码 → PNG
Say 'NapCat 已启动但未登录（6099 已开），正在取登录二维码…'

function Get-WebuiToken {
  if (Test-Path $webuiCfg) {
    try {
      $j = Get-Content $webuiCfg -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($j.token) { return [string]$j.token }
    } catch { }
  }
  if ($env:WEBUI_TOKEN) { return [string]$env:WEBUI_TOKEN }
  return ''
}

function Get-Sha256Hex([string]$text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text))
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
  } finally { $sha.Dispose() }
}

function Get-WebuiCredential {
  $token = Get-WebuiToken
  if (-not $token) { throw 'webui.json 里没有 token，无法调用 NapCat WebUI' }
  $body = @{ hash = (Get-Sha256Hex "$token.napcat") } | ConvertTo-Json -Compress
  $r = Invoke-RestMethod -Uri 'http://127.0.0.1:6099/api/auth/login' -Method Post `
    -ContentType 'application/json' -Body $body -TimeoutSec 15
  if ($r.code -ne 0 -or -not $r.data.Credential) {
    throw ('WebUI 登录失败：' + ($r.message | Out-String))
  }
  return [string]$r.data.Credential
}

function Get-QrContent([string]$credential) {
  $headers = @{ Authorization = 'Bearer ' + $credential }
  $r = Invoke-RestMethod -Uri 'http://127.0.0.1:6099/api/QQLogin/GetQQLoginQrcode' -Method Post `
    -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 20
  if ($r.code -ne 0) {
    $msg = [string]($r.message | Out-String)
    if ($msg -match 'logined|已登录') { return @{ loggedIn = $true } }
    throw ('取二维码失败：' + $msg)
  }
  $qr = $r.data
  if ($qr -is [string]) { return @{ qrcode = $qr } }
  return @{ qrcode = [string]$qr.qrcode }
}

function Refresh-QrContent([string]$credential) {
  $headers = @{ Authorization = 'Bearer ' + $credential }
  try { Invoke-RestMethod -Uri 'http://127.0.0.1:6099/api/QQLogin/RefreshQRcode' -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 15 | Out-Null } catch { }
}

function Save-QrPng([string]$content, [string]$file) {
  $dir = Split-Path -Parent $file
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  if ($content -match '^data:image/[a-z]+;base64,(.+)$') {
    [IO.File]::WriteAllBytes($file, [Convert]::FromBase64String($Matches[1]))
    return $true
  }
  if ($content -match '^https?://') {
    $encoded = [uri]::EscapeDataString($content)
    foreach ($renderBase in @('https://api.qrserver.com/v1/create-qr-code/?size=520x520&margin=12&data=', 'https://api.qrserver.com/v1/create-qr-code/?size=520x520&data=')) {
      try {
        Invoke-WebRequest -Uri ($renderBase + $encoded) -OutFile $file -TimeoutSec 30 -UseBasicParsing
        if ((Get-Item $file).Length -gt 200) { return $true }
      } catch { }
    }
    return $false
  }
  # 纯 base64（不带 data: 头）
  try {
    $bytes = [Convert]::FromBase64String($content)
    if ($bytes.Length -gt 200) { [IO.File]::WriteAllBytes($file, $bytes); return $true }
  } catch { }
  return $false
}

# Docker 日志里也带登录链接，WebUI 失败时兜底
function Get-QrFromLogs {
  try {
    $logs = & $docker logs --tail 300 napcat-qq 2>&1 | Out-String
    $m = [regex]::Match($logs, 'https://txz\.qq\.com/p\?k=[A-Za-z0-9_\-]+')
    if ($m.Success) { return $m.Value }
  } catch { }
  return ''
}

$credential = ''
$qr = ''
try {
  $credential = Get-WebuiCredential
  if ($Refresh) { Refresh-QrContent $credential }
  $qr = Get-QrContent $credential
} catch {
  Say ('[!] WebUI 取码失败：' + $_.Exception.Message) 'Yellow'
}

if ($qr -and $qr.loggedIn) {
  Say '[ok] 已经登录过了（WebUI 说已登录），无需扫码。' 'Green'
  exit 0
}

$content = if ($qr) { [string]$qr.qrcode } else { Get-QrFromLogs }
if (-not $content) {
  Fail '取不到二维码内容。手动打开 http://127.0.0.1:6099/webui 登录后看二维码（token 在 napcat\docker\config\webui.json）。'
}

Say ('二维码内容：' + $content) 'DarkGray'
if (Save-QrPng $content $OutFile) {
  Say ('[ok] 二维码已生成：' + $OutFile) 'Green'
} else {
  $txt = [IO.Path]::ChangeExtension($OutFile, '.txt')
  Set-Content -Path $txt -Value $content -Encoding UTF8
  Say ('[!] 出图失败，二维码内容已存：' + $txt) 'Yellow'
}
Say '请用户：打开上面的 PNG，用手机 QQ（机器人号 100000002）扫码登录。二维码约 2 分钟过期。' 'Cyan'
Say '扫完 3000/3001 会自动就绪，桥接会自动连上 127.0.0.1:3001。' 'Cyan'

if (-not $WaitLogin) {
  Say '（要自动等登录成功并刷新过期码，加 -WaitLogin 重跑本脚本）'
  exit 0
}

# ---------------------------------------------------------------- 5. 等扫码
Say '等待扫码登录（每 90 秒刷新一次二维码，Ctrl+C 可中断）…'
$deadline = (Get-Date).AddSeconds($LoginTimeoutSec)
$nextRefresh = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  if (Test-Port 3001) {
    $info = Get-LoginInfo
    $who = if ($info) { "$($info.nickname)（$($info.user_id)）" } else { '已登录' }
    Say ("[ok] 登录成功：$who，3001 已就绪") 'Green'
    Say '接下来：把控制台切到 Docker 模式（docs\napcat-docker-20261025.md 第 6 节），桥接会自动连上。'
    exit 0
  }
  if ((Get-Date) -ge $nextRefresh) {
    try {
      if (-not $credential) { $credential = Get-WebuiCredential }
      Refresh-QrContent $credential
      $qr = Get-QrContent $credential
      if ($qr -and $qr.qrcode) {
        $content = [string]$qr.qrcode
        if (Save-QrPng $content $OutFile) { Say ('[i] 已刷新二维码：' + $OutFile) 'Yellow' }
      }
    } catch { Say ('[!] 刷新二维码失败：' + $_.Exception.Message) 'Yellow' }
    $nextRefresh = (Get-Date).AddSeconds(90)
  }
  Start-Sleep -Seconds 2
  Write-Host '.' -NoNewline
}
Write-Host ''
Fail "等了 $LoginTimeoutSec 秒还没登录。重新跑一次本脚本（二维码会刷新）。"
