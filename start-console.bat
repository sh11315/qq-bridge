@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem ============================================================================
rem  QQ Bridge unified console launcher (ASCII-only, 2026-10-25)
rem    - one instance only: if 7788 is already listening, just open the browser
rem    - resolves node: D:\node.exe -> Program Files\nodejs -> PATH
rem    - ASCII-only so cmd/PowerShell quoting never mangles the path
rem ============================================================================

set "BOOK_DIR=%~dp0"
set "NODE_EXE=D:\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE="
if not defined NODE_EXE for %%i in (node.exe) do set "NODE_EXE=%%~$PATH:i"
if not defined NODE_EXE goto no_node

set "TOK="
if exist "state\console-token" set /p TOK=<"state\console-token"

powershell -NoProfile -Command "if ((Test-NetConnection -ComputerName 127.0.0.1 -Port 7788 -WarningAction SilentlyContinue).TcpTestSucceeded) { exit 0 } else { exit 1 }"
if errorlevel 1 goto start_console

echo Console is already running. Opening browser...
goto open_browser

:start_console
echo Starting console (node: %NODE_EXE%)...
rem Open the browser after a short delay through PowerShell. The old one-liner used
rem a nested start inside cmd /c, whose empty-title quotes collapsed and produced
rem "The system cannot find the path specified." in the console window.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:7788/'"
"%NODE_EXE%" console\server.mjs
set "CONSOLE_CODE=%errorlevel%"
echo.
echo Console exited (code=%CONSOLE_CODE%).
rem 0 = port already taken (the console prints "already running" itself): stay quiet.
if not "%CONSOLE_CODE%"=="0" pause
exit /b 0

:open_browser
if defined TOK (
    start "" "http://127.0.0.1:7788/?token=%TOK%"
) else (
    start "" "http://127.0.0.1:7788/"
)
exit /b 0

:no_node
echo [X] node.exe not found (tried D:\node.exe, Program Files\nodejs, PATH).
echo     Install Node.js or set NODE_EXE to the full path.
pause
exit /b 1
