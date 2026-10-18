@echo off
setlocal
cd /d "%~dp0"
set "npm_config_cache=%~dp0.npm-cache"

where npm.cmd >nul 2>nul
if errorlevel 1 goto :node_required
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto :node_required

node -e "import('sharp').catch(() => process.exit(1))"
if errorlevel 1 (
  echo Installing dependencies...
  call npm.cmd install
  if errorlevel 1 goto :failed
)
echo Building desktop UI...
call npm.cmd run build
if errorlevel 1 goto :failed
echo Starting self-wiki...
call npm.cmd run desktop
if errorlevel 1 goto :failed
goto :done

:node_required
echo Node.js 24 or newer is required for the maintained desktop app.
echo Install Node.js or use the packaged Windows application.
goto :failed

:failed
echo Startup failed. Check the messages above.
exit /b 1

:done
endlocal
