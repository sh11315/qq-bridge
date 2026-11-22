# install-pwsh.ps1 — 安装一份便携版 PowerShell 7（免管理员）。
#
# 为什么需要这个脚本（2026-10-25 结论）：
#   本机没有 `C:\Program Files\PowerShell\7\pwsh.exe`，只有 Windows PowerShell 5.1。
#   `dsh-pwsh-local` 会回退到 powershell.exe，所以「二进制缺失」本身不是
#   0xC0000142 的唯一原因；但给 DSH 一个真正的 pwsh 7 仍然是长期正确的部署形态
#   （PS 5.1 已停止功能更新，且 DSH 的 pwsh 工具以 pwsh 方言为契约）。
#
#   注意：**装 pwsh 7 不能修复 DSH 的 Windows ACL 沙箱**——本机实测
#   `dsh-pwsh-sandbox` 下 cmd.exe / PowerShell 5.1 / PowerShell 7 都会在
#   DLL 初始化阶段以 0xC0000142 退出；同一命令切到 danger-full-access 就正常。
#   桥接因此按「本回合发送者」切会话权限（见 src/bridge.js 的 applyTurnPermission）。
#   本脚本只负责把 pwsh 7 放到本地并告诉 DSH 去哪里找它。
#
# 用法：
#   pwsh -NoProfile -File scripts/install-pwsh.ps1
#   pwsh -NoProfile -File scripts/install-pwsh.ps1 -Version 7.6.8 -Destination D:\tools\pwsh7
#   pwsh -NoProfile -File scripts/install-pwsh.ps1 -SkipDshSetting   # 只装，不改 DSH 配置
#
# 装完后跑 `node scripts/set-pwsh-path.mjs`（或本脚本默认会尝试）把
# `pwsh-sandbox.pwshPath` 指到绝对路径；DSH 的 pwsh 执行器会在下一次调用时
# 重新探测这个路径（config 字段是 volatile 的）。

[CmdletBinding()]
param(
  [string]$Version = '7.6.8',
  [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\PowerShell\7'),
  [string]$MirrorBase = 'https://mirrors.tuna.tsinghua.edu.cn/github-release/PowerShell/PowerShell',
  [switch]$SkipDshSetting,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$text) { Write-Host ('[install-pwsh] ' + $text) }

$exe = Join-Path $Destination 'pwsh.exe'
if ((Test-Path $exe) -and -not $Force) {
  $installedVersion = & $exe -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
  Write-Step ('已存在：' + $exe + '（版本 ' + $installedVersion + '）')
} else {
  $zip = Join-Path $env:TEMP ('PowerShell-' + $Version + '-win-x64.zip')
  # 清华镜像对国内网络更稳；失败再回退 GitHub release。
  # 用 -f 拼接，避免在双引号里塞 $() 嵌套（PS 5.1 的解析器对长嵌套很脆）。
  $urls = @(
    ('{0}/v{1}%20Release%20of%20PowerShell/PowerShell-{1}-win-x64.zip' -f $MirrorBase, $Version),
    ('https://github.com/PowerShell/PowerShell/releases/download/v{0}/PowerShell-{0}-win-x64.zip' -f $Version)
  )
  $downloaded = $false
  foreach ($url in $urls) {
    try {
      Write-Step ('下载 ' + $url)
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 600
      if ((Get-Item $zip).Length -lt 50MB) {
        throw ('下载文件过小（' + (Get-Item $zip).Length + ' 字节），可能不是 zip')
      }
      $downloaded = $true
      break
    } catch {
      Write-Warning ('下载失败：' + $_.Exception.Message)
      Remove-Item $zip -Force -ErrorAction SilentlyContinue
    }
  }
  if (-not $downloaded) { throw 'PowerShell 7 下载失败：镜像与 GitHub 都不可用' }

  if (Test-Path $Destination) { Remove-Item $Destination -Recurse -Force }
  New-Item -ItemType Directory -Force $Destination | Out-Null
  Write-Step ('解压到 ' + $Destination)
  Expand-Archive -Path $zip -DestinationPath $Destination -Force
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path $exe)) { throw ('解压后找不到 ' + $exe) }
  $installedVersion = & $exe -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
  Write-Step ('安装完成：' + $installedVersion)
}

if (-not $SkipDshSetting) {
  $setter = Join-Path $repoRoot 'scripts\set-pwsh-path.mjs'
  if (Test-Path $setter) {
    Write-Step '把 pwshPath 写入 DSH 设置（pwsh-sandbox 命名空间）…'
    & (Get-Command node).Source $setter $exe
    if ($LASTEXITCODE -ne 0) {
      Write-Warning ('设置写入失败（exit ' + $LASTEXITCODE + '）。DSH 未运行时可以先启动 DSH，再手动跑：node scripts/set-pwsh-path.mjs "' + $exe + '"')
    }
  } else {
    Write-Warning ('找不到 ' + $setter + '；请手动在 DSH 的 pwsh-sandbox 设置里把 pwshPath 指向 ' + $exe)
  }
}

Write-Step '完成。注意：Windows ACL 沙箱下的 0xC0000142 是 DSH 沙箱环境问题，本脚本不会修复它；桥接已按回合切权限。'
