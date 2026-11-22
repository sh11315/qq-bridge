@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem ============================================================================
rem  QQ Bridge 统一控制台启动器（2026-10-25 修复版）
rem    · 已运行（7788 被占）→ 只打开浏览器，不启第二个实例
rem    · 显式解析 node：D:\node.exe → Program Files\nodejs → PATH
rem    · 用 goto 而不是嵌套 if 块，避免批处理括号解析问题
rem ============================================================================

set "NODE_EXE=D:\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE="
if not defined NODE_EXE for %%i in (node.exe) do set "NODE_EXE=%%~$PATH:i"
if not defined NODE_EXE goto no_node

set "TOK="
if exist "state\console-token" set /p TOK=<"state\console-token"

powershell -NoProfile -Command "if ((Test-NetConnection -ComputerName 127.0.0.1 -Port 7788 -WarningAction SilentlyContinue).TcpTestSucceeded) { exit 0 } else { exit 1 }"
if errorlevel 1 goto start_console

echo 控制台已在运行，直接打开浏览器。
goto open_browser

:start_console
echo 启动控制台（node: %NODE_EXE%）...
start "" "http://127.0.0.1:7788/"
"%NODE_EXE%" console\server.mjs
echo.
echo 控制台已退出（code=%errorlevel%）。
pause
exit /b 0

:open_browser
if defined TOK (
    start "" "http://127.0.0.1:7788/?token=%TOK%"
) else (
    start "" "http://127.0.0.1:7788/"
)
exit /b 0

:no_node
echo [X] 找不到 node.exe（已尝试 D:\node.exe、Program Files\nodejs、PATH）
echo     请安装 Node.js，或把本文件里的 NODE_EXE 改成完整路径。
pause
exit /b 1
