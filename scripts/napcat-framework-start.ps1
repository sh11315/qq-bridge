<#
.SYNOPSIS
  手动启动 NapCat.Framework（注入已安装的桌面 QQ），用于控制台之外的手工起停/排障。

.DESCRIPTION
  做的事（与官方 napiLoader.bat 等价，但带本项目需要的两道保险）：
    1) 校验 <NapcatDir> 里有 napimain.exe / napiloader.dll / nativeLoader.cjs；
    2) 把目录的完整性标签修正为 Medium（DSH 沙箱可能把它打成 Low，Low 会导致注入后 QQ 秒崩）；
    3) 确认当前没有 QQ.exe（QQ 单实例，已有 QQ 时再注入只会激活旧窗口/双实例互踢）；
    4) 执行 napimain.exe <QQ.exe> <napiloader.dll> <nativeLoader.cjs>（普通权限即可，无需 UAC）；
    5) 等 6099（等扫码）或 3001（已登录）就绪，并打印二维码 URL。

  注意：
    - QQ 会以 GUI 形式启动，登录（扫码）必须在 QQ 窗口里完成。
    - 登录的是机器人账号（默认 100000002）；登录后 3000/3001 才会开。
    - 机器人运行期间不要再用桌面 QQ 登录其他账号：同一 Windows 用户共用
      <我的文档>\Tencent Files，两个实例会互相踢。

.PARAMETER NapcatDir
  Framework 目录，默认 <项目根>\napcat\framework。

.PARAMETER QQPath
  要注入的 QQ.exe，默认 D:\QQ.exe（本项目实测的 QQ 9.9.36-53644 安装位置）。

.PARAMETER WaitSeconds
  等待 6099/3001 的最长秒数，默认 60。

.PARAMETER Force
  即使检测到 QQ.exe 在跑也继续启动（不推荐）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\napcat-framework-start.ps1
#>
[CmdletBinding()]
param(
  [string]$NapcatDir = '',
  [string]$QQPath = 'D:\QQ.exe',
  [int]$WaitSeconds = 60,
  [switch]$Force
)

if (-not $NapcatDir) { $NapcatDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'napcat\framework' }
$ErrorActionPreference = 'Stop'

# 1) 文件校验
$launcher = Join-Path $NapcatDir 'napimain.exe'
$inject = Join-Path $NapcatDir 'napiloader.dll'
$main = Join-Path $NapcatDir 'nativeLoader.cjs'
foreach ($f in @($launcher, $inject, $main)) {
  if (-not (Test-Path $f)) {
    Write-Host "[x] 缺少文件：$f" -ForegroundColor Red
    exit 2
  }
}
if (-not (Test-Path $QQPath)) {
  Write-Host "[x] 找不到 QQ.exe：$QQPath（用 -QQPath 指定）" -ForegroundColor Red
  exit 2
}

# 2) 完整性标签（Low 会导致 QQ 注入后 0x80000003 崩溃）
$label = (& icacls $NapcatDir) -join "`n"
if ($label -match 'Low Mandatory Level') {
  Write-Host '[!] 目录带 Low 完整性标签（注入会崩），正在改为 Medium…' -ForegroundColor Yellow
  & icacls $NapcatDir /setintegritylevel '(OI)(CI)M' /T /C /Q | Out-Null
  Write-Host '[ok] 已改为 Medium'
} else {
  Write-Host '[ok] 完整性标签正常（非 Low）'
}

# 3) QQ 单实例检查
$qq = @(Get-Process -Name QQ -ErrorAction SilentlyContinue)
if ($qq.Count -gt 0) {
  Write-Host ("[!] 检测到 QQ.exe 进程：" + (($qq | ForEach-Object { $_.Id }) -join ',')) -ForegroundColor Yellow
  if (-not $Force) {
    Write-Host '[x] QQ 已在运行：请先完全退出（含托盘图标），或确认它是注入实例（6099/3001 已开）' -ForegroundColor Red
    exit 3
  }
}

# 4) 启动注入
Write-Host "[>] 注入启动：$QQPath"
Write-Host ("    DLL   : $inject")
Write-Host ("    Script: $main")
$p = Start-Process -FilePath $launcher `
  -ArgumentList @($QQPath, $inject, ($main -replace '\\', '/')) `
  -WorkingDirectory $NapcatDir -PassThru
Write-Host ("[i] 启动器 PID " + $p.Id + "（拉起 QQ 后它自己会退出，QQ 继续运行）")

# 5) 等端口
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$ws = $false; $webui = $false
while ((Get-Date) -lt $deadline) {
  $listening = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 3001, 6099 })
  $webui = [bool]($listening | Where-Object { $_.LocalPort -eq 6099 })
  $ws = [bool]($listening | Where-Object { $_.LocalPort -eq 3001 })
  if ($ws) { break }
  if ($webui) { break }
  Start-Sleep -Milliseconds 1500
}

$mainQq = Get-Process -Name QQ -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
if (-not $webui -and -not $ws) {
  Write-Host '[x] 等了超时也没看到 6099/3001：看桌面有没有 QQ 窗口，或查事件日志 Application Error（QQ.exe / QQNT.dll）' -ForegroundColor Red
  if ($mainQq) { Write-Host ("    但 QQ 在跑：PID " + $mainQq.Id) }
  exit 4
}

Write-Host '[ok] 已就绪：' -ForegroundColor Green
if ($mainQq) { Write-Host ("    QQ 主进程 PID : " + $mainQq.Id) }
Write-Host  ("    WebUI 6099    : " + $(if ($webui) { '监听中' } else { '未监听' }))
Write-Host  ("    OneBot 3001   : " + $(if ($ws) { '监听中（已登录）' } else { '未监听（还没登录）' }))

if (-not $ws) {
  Write-Host ''
  Write-Host '下一步：用手机 QQ 扫描 QQ 登录窗口里的二维码，登录机器人账号（默认 100000002）。' -ForegroundColor Cyan
  Write-Host '  取最新二维码 URL：POST http://127.0.0.1:7788/api/napcat/qrcode  (body {"refresh":true}，带 x-console-token)'
  Write-Host '  或直接看控制台 http://127.0.0.1:7788 的“NapCat 二维码”。'
}
exit 0
