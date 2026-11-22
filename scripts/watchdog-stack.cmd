@echo off
rem 全栈看门狗启动器（由计划任务 QQBridge-Watchdog 每 3 分钟调用）。
rem 依次尝试：PATH 里的 node → D:\node.exe → Program Files\nodejs\node.exe
cd /d "%~dp0.."
set "NODE_EXE="
for %%i in (node.exe) do set "NODE_EXE=%%~$PATH:i"
if not defined NODE_EXE if exist "D:\node.exe" set "NODE_EXE=D:\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE (
  echo [watchdog] node.exe not found >> state\watchdog.log
  exit /b 1
)
"%NODE_EXE%" scripts\watchdog-stack.mjs
exit /b %errorlevel%
