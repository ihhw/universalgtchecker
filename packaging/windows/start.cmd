@echo off
REM Starts Universal Checker on http://localhost:8080 . Close this window to stop it.
cd /d "%~dp0\..\.."
if not exist "artifacts\api-server\dist\public\index.html" (
  echo Not built yet. Run packaging\windows\build.cmd first.
  pause
  exit /b 1
)
set PORT=8080
set NODE_ENV=production
start "" http://localhost:8080
node artifacts\api-server\dist\index.mjs
pause
