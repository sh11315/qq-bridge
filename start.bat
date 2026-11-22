@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
rem Read-only config shape check (schemaVersion / unknown top-level keys).
rem Warnings never block startup; run node scripts\validate-config.mjs to see details.
node scripts\validate-config.mjs --quiet
node scripts\harden-state-acl.mjs --quiet
rem Single instance: if 3100 is already listening, do NOT start a second copy.
rem The lock-file guard in src/bridge.js would exit 2 and leave a paused window
rem that looks like an error, so check the port first and exit quietly.
powershell -NoProfile -Command "if ((Test-NetConnection -ComputerName 127.0.0.1 -Port 3100 -WarningAction SilentlyContinue).TcpTestSucceeded) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
    echo Bridge is already running on port 3100. Nothing to do.
    timeout /t 3 /nobreak >nul
    exit /b 0
)
:loop
node src/bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running (state\bridge.lock held). Exiting quietly.
    timeout /t 3 /nobreak >nul
    exit /b 0
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
