@echo off
setlocal
title RP Terminal Launcher
cd /d "%~dp0"

if not exist "package.json" (
  echo RP Terminal could not find package.json.
  echo Put this launcher in the root of the RP Terminal clone.
  goto :failure
)

where node >nul 2>&1
if errorlevel 1 goto :node_missing
where npm.cmd >nul 2>&1
if errorlevel 1 goto :node_missing

echo Preparing RP Terminal...
call npm.cmd install
if errorlevel 1 goto :failure

echo Building RP Terminal...
call npm.cmd run build
if errorlevel 1 goto :failure

echo Starting RP Terminal...
call npm.cmd run start
if errorlevel 1 goto :failure
exit /b 0

:node_missing
echo Node.js 22 or later is required to run RP Terminal.

:failure
echo.
echo RP Terminal did not start. Review the message above, then try again.
pause
exit /b 1
