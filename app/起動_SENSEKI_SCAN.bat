@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first: https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules\electron\package.json (
  echo Setup: installing dependencies...
  call npm install --no-audit --no-fund
)

if exist node_modules\electron\dist\electron.exe goto :run

echo Electron binary missing. Extracting from download cache...
set "EZIP=%LOCALAPPDATA%\electron\Cache\88235104d26da3ef5ac14266e9fa3215cbe53b9c4c7af05394addc599109230d\electron-v38.8.6-win32-x64.zip"
if not exist "%EZIP%" (
  echo Cache zip not found. Downloading via installer script...
  node node_modules\electron\install.js
)
if exist "%EZIP%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%EZIP%' -DestinationPath 'node_modules\electron\dist' -Force; Set-Content -Path 'node_modules\electron\path.txt' -Value 'electron.exe' -NoNewline"
)

if not exist node_modules\electron\dist\electron.exe (
  echo [ERROR] Electron could not be set up. Please report this message.
  pause
  exit /b 1
)

:run
call npm start
pause
