# Long-running NapCat login/init verifier (read-only).
# Writes incremental evidence to state\_napcat-login-watch.log and a one-line
# verdict to state\_napcat-login-verdict.txt.
param([int]$Minutes = 40)

$ErrorActionPreference = 'SilentlyContinue'
$root = 'C:\qq-bridge'
$token = (Get-Content (Join-Path $root 'state\console-token') -Raw).Trim()
$headers = @{ 'x-console-token' = $token }
$logFile = Join-Path $root 'state\_napcat-login-watch.log'
$verdictFile = Join-Path $root 'state\_napcat-login-verdict.txt'
$deadline = (Get-Date).AddMinutes($Minutes)
$seen = @{}
$patterns = @('[ServerTime]', '[Packet]', '[AdapterManager]', 'LoginSucce', 'session.init', 'onOpentelemetryInit', 'failed', 'FAILED', 'Error')

function PortOpen([int]$p) {
  try { return [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction Stop) } catch { return $false }
}

"[watch] start $(Get-Date -Format 'HH:mm:ss') minutes=$Minutes" | Out-File $logFile -Encoding utf8
$last = ''
$final = 'TIMEOUT'
while ((Get-Date) -lt $deadline) {
  $st = $null
  try { $st = Invoke-RestMethod -Uri 'http://127.0.0.1:7788/api/status' -Headers $headers -TimeoutSec 8 } catch { }
  $phase = if ($st) { [string]$st.services.napcat.loginPhase } else { '?' }
  $online = if ($st) { [string]$st.napcatLogin.online } else { '?' }
  $ws = if ($st) { [string]$st.services.bridge.wsConnected } else { '?' }
  $acct = if ($st) { [string]$st.services.bridge.accountOnline } else { '?' }
  $p3000 = PortOpen 3000
  $p3001 = PortOpen 3001
  $line = "[{0}] phase={1} napcatOnline={2} bridgeWs={3} accountOnline={4} 3000={5} 3001={6}" -f (Get-Date -Format 'HH:mm:ss'), $phase, $online, $ws, $acct, $p3000, $p3001
  if ($line -ne $last) { $line | Out-File $logFile -Append -Encoding utf8; $last = $line }

  $logs = $null
  try { $logs = Invoke-RestMethod -Uri 'http://127.0.0.1:7788/api/logs?svc=napcat&limit=100' -Headers $headers -TimeoutSec 8 } catch { }
  if ($logs -and $logs.logs) {
    foreach ($l in $logs.logs) {
      $t = [string]$l.text
      foreach ($pat in $patterns) {
        if ($t -and $t.Contains($pat)) {
          $key = $t.Substring(0, [Math]::Min(140, $t.Length))
          if (-not $seen.ContainsKey($key)) { $seen[$key] = 1; ('  LOG> ' + $t) | Out-File $logFile -Append -Encoding utf8 }
        }
      }
    }
  }

  if ($p3000 -and $p3001) {
    $final = 'SUCCESS'
    ('[{0}] 3000/3001 listening -> SUCCESS; phase={1} napcatOnline={2} bridgeWs={3} accountOnline={4}' -f (Get-Date -Format 'HH:mm:ss'), $phase, $online, $ws, $acct) | Out-File $logFile -Append -Encoding utf8
    break
  }

  # verdict heartbeat every ~8 cycles
  if ((Get-Date).Second -lt 9) {
    ('{0} phase={1} napcatOnline={2} bridgeWs={3} 3000={4} 3001={5}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $phase, $online, $ws, $p3000, $p3001) | Out-File $verdictFile -Encoding utf8
  }
  Start-Sleep -Seconds 8
}
('[watch] end {0} result={1}' -f (Get-Date -Format 'HH:mm:ss'), $final) | Out-File $logFile -Append -Encoding utf8
('{0} result={1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $final) | Out-File $verdictFile -Encoding utf8
