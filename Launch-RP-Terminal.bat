@echo off
setlocal EnableExtensions EnableDelayedExpansion
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

set "SOURCE_VERSION="
for /f "delims=" %%V in ('node -p "require('./package.json').version"') do set "SOURCE_VERSION=%%V"
if not defined SOURCE_VERSION goto :version_missing

if exist "node_modules\" if exist "out\main\index.js" if exist ".rpt-build-version" (
  set "BUILT_VERSION="
  <".rpt-build-version" set /p "BUILT_VERSION="
  if "!SOURCE_VERSION!"=="!BUILT_VERSION!" (
    echo RP Terminal !SOURCE_VERSION! is already built.
    goto :launch
  )
)

echo Preparing RP Terminal...
call npm.cmd install
if errorlevel 1 goto :failure

echo Building RP Terminal...
call npm.cmd run build
if errorlevel 1 goto :failure

>".rpt-build-version" echo !SOURCE_VERSION!

:launch
echo Starting RP Terminal...
call npm.cmd run start
if errorlevel 1 goto :failure
exit /b 0

:node_missing
echo Node.js 22 or later is required to run RP Terminal.
goto :failure

:version_missing
echo RP Terminal could not read the version from package.json.

:failure
echo.
echo RP Terminal did not start. Review the message above, then try again.
pause
exit /b 1
