@echo off
cd /d "%~dp0"
node node_modules/electron/cli.js tools/aionui-ab-desktop.mjs
if errorlevel 1 pause
