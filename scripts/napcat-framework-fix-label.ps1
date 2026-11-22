<#
.SYNOPSIS
  把 NapCat.Framework 目录的完整性标签从 Low 改回 Medium（修复“注入后 QQ 秒崩”）。

.DESCRIPTION
  背景（2026-10-25 实测）：
    DSH 沙箱在 workspace-write 模式下会把工作区（C:\qq-bridge）
    及其子目录打上 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`。
    NapCat.Framework 目录就在工作区里，QQ 注入时从 Low 完整性目录加载 napiloader.dll，
    会在 QQNT.dll+0x26b6e3a 抛出 0x80000003 并立刻退出（事件日志“应用程序错误”，
    与 NapCat 上游 issue #2116 完全一致；该 issue 评论也指出是 DSH 这类工具打的 low 标签）。

  修复：
    icacls <dir> /setintegritylevel (OI)(CI)M /T /C
    —— 把目录和其中所有文件改成 Medium 完整性，之后注入即正常。

  该脚本是幂等的：标签已经是 Medium 时只报告、不改动（除非 -Force）。

.PARAMETER NapcatDir
  Framework 目录，默认 <项目根>\napcat\framework。

.PARAMETER Force
  即使当前不是 Low 也强制执行一次设置。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\napcat-framework-fix-label.ps1

.NOTES
  不需要管理员权限（目录属于当前用户即可）。本脚本只改完整性标签，不碰 ACL 其他部分。
#>
[CmdletBinding()]
param(
  [string]$NapcatDir = '',
  [switch]$Force
)

if (-not $NapcatDir) { $NapcatDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'napcat\framework' }
$ErrorActionPreference = 'Stop'

if (-not (Test-Path (Join-Path $NapcatDir 'napiLoader.bat'))) {
  Write-Host "[x] 不是 NapCat.Framework 目录：$NapcatDir" -ForegroundColor Red
  exit 2
}

Write-Host "[*] 目录：$NapcatDir"
$before = (& icacls $NapcatDir) -join "`n"
$isLow = $before -match 'Low Mandatory Level'
if ($isLow) {
  Write-Host '[!] 检测到 Low 完整性标签（这就是注入后 QQ 崩溃的根因）' -ForegroundColor Yellow
} else {
  Write-Host '[ok] 当前不是 Low 标签'
  if (-not $Force) {
    Write-Host '[=] 无需修改（要强制重设加 -Force）'
    exit 0
  }
}

Write-Host '[>] 正在把目录及所有文件设为 Medium 完整性…'
& icacls $NapcatDir /setintegritylevel '(OI)(CI)M' /T /C /Q | Out-Null

$after = (& icacls $NapcatDir) -join "`n"
if ($after -match 'Low Mandatory Level') {
  Write-Host '[x] 仍然存在 Low 标签，请检查权限/是否被其他策略重新打标' -ForegroundColor Red
  exit 1
}

# 关键文件单独回读一次，确认已生效
foreach ($f in 'napiloader.dll', 'napcat.mjs', 'nativeLoader.cjs') {
  $file = Join-Path $NapcatDir $f
  if (Test-Path $file) {
    $line = (& icacls $file) -join "`n"
    $level = if ($line -match 'Medium Mandatory Level') { 'Medium' } elseif ($line -match 'Low Mandatory Level') { 'Low' } else { '未设置' }
    Write-Host ("    {0,-18} {1}" -f $f, $level)
  }
}

Write-Host '[ok] 完成：现在可以重新注入启动（scripts\napcat-framework-start.ps1 或控制台“启动”）' -ForegroundColor Green
exit 0
