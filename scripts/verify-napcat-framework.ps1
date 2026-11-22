<#
.SYNOPSIS
  验证 NapCat.Framework 是否真正跑通（端口 / 登录 / AdapterManager / 桥接 / 群收发链路）。

.DESCRIPTION
  逐项检查并打印 PASS/FAIL：
    1) 3000/3001/6099 是否监听，且 6099 的 PID = QQ.exe（Framework 特征）；
    2) 控制台 /api/status：services.napcat.up / mode=framework / napcatLogin.online / uin；
    3) OneBot HTTP get_login_info（3000）能返回账号；
    4) NapCat 日志里是否出现 [AdapterManager] 适配器初始化完成；
    5) 桥接 /api/status 的 wsConnected / accountOnline；
    6) 桥接日志最近是否有收发记录（只统计，不判定 FAIL）。

.PARAMETER ConsolePort
  控制台端口，默认 7788。

.PARAMETER Uin
  期望登录的机器人 QQ，默认 100000002。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-napcat-framework.ps1
#>
[CmdletBinding()]
param(
  [int]$ConsolePort = 7788,
  [string]$Uin = '100000002'
)

if (-not $PSScriptRoot) { $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$root = Split-Path -Parent $PSScriptRoot
$ErrorActionPreference = 'Continue'

$results = New-Object System.Collections.ArrayList
function Check($name, $ok, $detail) {
  [void]$results.Add([pscustomobject]@{ Name = $name; Ok = [bool]$ok; Detail = $detail })
  $tag = if ($ok) { '[PASS]' } else { '[FAIL]' }
  $color = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ("$tag $name" + $(if ($detail) { "  -> $Detail" } else { '' })) -ForegroundColor $color
}

# 控制台 token
$token = ''
$tokenFile = Join-Path $root 'state\console-token'
if (Test-Path $tokenFile) { $token = (Get-Content $tokenFile -Raw).Trim() }
$headers = @{}
if ($token) { $headers['x-console-token'] = $token }

# 1) 端口
$listen = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
$p3000 = $listen | Where-Object { $_.LocalPort -eq 3000 } | Select-Object -First 1
$p3001 = $listen | Where-Object { $_.LocalPort -eq 3001 } | Select-Object -First 1
$p6099 = $listen | Where-Object { $_.LocalPort -eq 6099 } | Select-Object -First 1
Check '3000 HTTP 监听' ([bool]$p3000) $(if ($p3000) { "PID " + $p3000.OwningProcess } else { '未监听（未登录）' })
Check '3001 WS 监听'   ([bool]$p3001) $(if ($p3001) { "PID " + $p3001.OwningProcess } else { '未监听（未登录）' })
Check '6099 WebUI 监听' ([bool]$p6099) $(if ($p6099) { "PID " + $p6099.OwningProcess } else { '未监听' })

# 6099 的进程应该是 QQ.exe
if ($p6099) {
  $proc = Get-Process -Id $p6099.OwningProcess -ErrorAction SilentlyContinue
  Check '6099 由 QQ.exe 持有（Framework 注入）' ($proc -and $proc.ProcessName -eq 'QQ') $(if ($proc) { $proc.ProcessName + ' pid=' + $proc.Id } else { '取不到进程' })
}

# 2) 控制台状态
$status = $null
try { $status = Invoke-RestMethod -Uri "http://127.0.0.1:$ConsolePort/api/status" -Headers $headers -TimeoutSec 25 } catch { }
if ($status) {
  $n = $status.services.napcat
  Check 'status.napcat.mode=framework' ($n.mode -eq 'framework') ('mode=' + $n.mode)
  Check 'status.napcat.up（3001 可连）' ([bool]$n.up) ('up=' + $n.up)
  Check 'napcatLogin.online' ([bool]$status.napcatLogin.online) ('online=' + $status.napcatLogin.online + ' phase=' + $status.napcatLogin.loginPhase + ' error=' + $status.napcatLogin.error)
  if ($status.napcatLogin.online) {
    Check '登录账号 = ' $Uin ($status.napcatLogin.uin -eq $Uin) ('uin=' + $status.napcatLogin.uin + ' nick=' + $status.napcatLogin.nick)
  }
  $b = $status.services.bridge
  Check '桥接 wsConnected' ([bool]$b.wsConnected) ('wsConnected=' + $b.wsConnected)
  Check '桥接 accountOnline' ([bool]$b.accountOnline) ('accountOnline=' + $b.accountOnline)
} else {
  Check '控制台 /api/status' $false "不可达 http://127.0.0.1:$ConsolePort"
}

# 3) OneBot get_login_info
try {
  $info = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/get_login_info' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 8
  $ok = $info.status -eq 'ok' -and $info.data
  Check 'OneBot get_login_info' $ok $(if ($ok) { 'uin=' + $info.data.user_id + ' nick=' + $info.data.nickname } else { '返回异常' })
} catch {
  Check 'OneBot get_login_info' $false $_.Exception.Message
}

# 4) AdapterManager 日志
$logFiles = @()
$logDir = Join-Path $root 'napcat\framework\logs'
if (Test-Path $logDir) { $logFiles += Get-ChildItem $logDir -File -Include '*.log', '*.txt' -Recurse -ErrorAction SilentlyContinue }
if (Test-Path $logDir) { $logFiles += Get-ChildItem $logDir -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Extension -notin '.log', '.txt' } }
$logFiles = $logFiles | Sort-Object FullName -Unique
$adapterHits = @()
foreach ($f in $logFiles) {
  $m = Select-String -Path $f.FullName -Pattern 'AdapterManager|适配器初始化完成' -ErrorAction SilentlyContinue
  if ($m) { $adapterHits += $m | Select-Object -First 3 }
}
Check '[AdapterManager] 出现在日志' ($adapterHits.Count -gt 0) $(if ($adapterHits.Count) { $adapterHits[-1].Line.Trim() } else { '未找到（登录后才会打印）' })

# 5) 桥接日志收发统计
$bridgeLog = Join-Path $root 'state\bridge.log'
if (Test-Path $bridgeLog) {
  $tail = Get-Content $bridgeLog -Tail 2000 -ErrorAction SilentlyContinue
  $recv = @($tail | Where-Object { $_ -match '接收\s*<-|收到\s*<' }).Count
  $sent = @($tail | Where-Object { $_ -match '发送\s*->' }).Count
  Write-Host ("[INFO] 桥接日志最近 2000 行：接收 $recv 条 / 发送 $sent 条（收发需群里有人说话或发测试消息）")
}

Write-Host ''
$fail = @($results | Where-Object { -not $_.Ok }).Count
$pass = $results.Count - $fail
Write-Host ("结果：$pass 通过 / $fail 失败（共 " + $results.Count + ' 项）') -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Yellow' })
if ($fail -gt 0) {
  Write-Host '提示：3000/3001 未监听通常是还没扫码登录；6099 没有则 NapCat/QQ 没起来。' -ForegroundColor Yellow
  Write-Host '  取二维码：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\napcat-show-qr.ps1 -Refresh' -ForegroundColor Yellow
}
exit $(if ($fail -eq 0) { 0 } else { 1 })
