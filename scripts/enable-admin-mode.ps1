# 一键把「QQ Bridge 控制台 + 桥接 + DSH」切到管理员权限（Windows）。
#
# 为什么需要你点一下：Windows 的 UAC 不允许普通进程静默提权。
# 这个脚本必须以管理员身份运行（右键「以管理员身份运行」，或在弹出的 UAC 里点「是」）。
#
# 它做四件事：
#   1. 注册登录任务 QQBridge-ConsoleAdmin（最高权限，登录时自动起控制台）；
#   2. 立刻用这个任务启动一个管理员权限的控制台；
#   3. 重启桥接与 DSH，让它们继承管理员权限；
#   4. 写 state/admin-mode.json 记下状态。
#
# 回滚：运行 scripts/disable-admin-mode.ps1（同样要管理员）。

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host ''
  Write-Host '需要管理员权限：请右键这个脚本 →「以管理员身份运行」。' -ForegroundColor Yellow
  Write-Host ''
  exit 1
}

$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repo 'desktop-app\QQBridgeConsole.exe'
if (-not (Test-Path $exe)) { throw "找不到控制台启动器：$exe" }
$stateDir = Join-Path $repo 'state'
$tokenFile = Join-Path $stateDir 'console-token'

Write-Host "仓库：$repo"

# 1) 停掉当前（普通权限）的控制台；桥接/DSH 是它的 detached 子进程，会先留着，稍后重启。
$conn = Get-NetTCPConnection -LocalPort 7788 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  Write-Host "停止当前控制台 PID $($conn.OwningProcess)…"
  Stop-Process -Id $conn.OwningProcess -Force
  Start-Sleep -Seconds 4
}
# 关键：启动器是单实例的，旧启动器还在的话，任务里的新启动器只会唤起旧窗口然后退出，
# 控制台又会以普通权限被旧启动器拉起来。所以先把启动器进程也结束。
Get-Process QQBridgeConsole -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "停止旧启动器 PID $($_.Id)…"
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# 2) 注册「登录时以最高权限启动控制台」的任务
$taskName = 'QQBridge-ConsoleAdmin'
$tr = '"' + $exe + '"'
schtasks /Create /TN $taskName /TR $tr /SC ONLOGON /RL HIGHEST /F | Out-Null
Write-Host "已注册计划任务 $taskName（登录时最高权限启动）"

# 3) 立刻触发一次
schtasks /Run /TN $taskName | Out-Null
Write-Host '正在以管理员权限启动控制台…'

$up = $false
for ($i = 0; $i -lt 90; $i++) {
  if (Get-NetTCPConnection -LocalPort 7788 -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $up) { throw '控制台 90 秒内没有起来；请查看 desktop-app 窗口或控制台日志。' }
Write-Host '控制台已起来（管理员）' -ForegroundColor Green
Start-Sleep -Seconds 6

# 4) 重启桥接与 DSH，让子进程继承管理员令牌
if (Test-Path $tokenFile) {
  $token = (Get-Content $tokenFile -Raw).Trim()
  $headers = @{ 'x-console-token' = $token; 'Content-Type' = 'application/json' }
  foreach ($svc in @('bridge', 'dsh')) {
    try {
      Write-Host "重启 $svc（继承管理员权限）…"
      $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7788/api/service/$svc/restart" -Headers $headers -Body '{}' -TimeoutSec 30
      Write-Host "  $svc：$($r.message)"
    } catch {
      Write-Host "  $svc 重启失败：$($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
}

# 5) 记录状态
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
@{
  enabled = $true
  at = (Get-Date).ToString('o')
  task = $taskName
  exe = $exe
} | ConvertTo-Json | Set-Content -Path (Join-Path $stateDir 'admin-mode.json') -Encoding UTF8

Write-Host ''
Write-Host '完成：控制台、桥接、DSH 现在都以管理员权限运行。' -ForegroundColor Green
Write-Host '控制台「实时日志」里应能看到：控制台以管理员权限运行。'
Write-Host '回滚：右键 scripts\disable-admin-mode.ps1 → 以管理员身份运行。'
