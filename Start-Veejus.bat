@echo off
rem Double-click to start Veejus.
rem   Start-Veejus.bat        build the latest code, then run the app (no console left open)
rem   Start-Veejus.bat dev    run in development mode with hot reload (keeps this console open)

setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing dependencies, this can take a minute...
  call npm install
  if errorlevel 1 goto :failed
  if not exist "node_modules\electron\dist\electron.exe" (
    call node node_modules\electron\install.js
    if errorlevel 1 goto :failed
  )
)

if /i "%~1"=="dev" (
  call npm run dev
  exit /b
)

echo Building Veejus...
call npm run build >nul
if errorlevel 1 goto :failed

start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:failed
echo.
echo Veejus could not start. See the messages above.
pause
exit /b 1
