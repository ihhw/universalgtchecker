@echo off
REM Builds Universal Checker on Windows. Needs Node.js 22 and pnpm (npm install -g pnpm).
cd /d "%~dp0\..\.."
echo ==^> Installing dependencies
call pnpm install || goto :fail
echo ==^> Building
set PORT=1
set BASE_PATH=/
set NODE_ENV=production
call pnpm build || goto :fail
echo ==^> Assembling
if exist "artifacts\api-server\dist\public" rmdir /s /q "artifacts\api-server\dist\public"
xcopy /e /i /q "artifacts\gamertag-finder\dist\public" "artifacts\api-server\dist\public" >nul || goto :fail
echo.
echo Build complete. Start it with packaging\windows\start.cmd
pause
exit /b 0
:fail
echo.
echo BUILD FAILED - send a screenshot of the error above.
pause
exit /b 1
