@echo off
setlocal
title Atlas + Form Studio
cd /d "%~dp0"

rem One double-click: starts Form Studio (FOMS, in the foms folder) and
rem the Atlas portal on this computer, then opens the portal in the
rem browser. The live portal on the internet does not need this file;
rem to use only Form Studio with it, run foms\launch_foms.bat instead.

if not defined ATLAS_PORT set "ATLAS_PORT=3000"
set "ATLAS_URL=http://localhost:%ATLAS_PORT%"

rem --- Form Studio in its own window (it installs what it needs on first run) ---
if exist "foms\launch_foms.bat" (
    start "FOMS - Form Studio" cmd /c "foms\launch_foms.bat"
) else (
    echo [WARN] foms\launch_foms.bat was not found - Form Studio is not started.
)

rem --- Atlas needs Node.js ---
where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found. Install it from https://nodejs.org and try again.
    pause
    exit /b 1
)
if not exist "node_modules" (
    echo Installing Atlas dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] Could not install dependencies.
        pause
        exit /b 1
    )
)
if not exist ".env.local" (
    echo [WARN] .env.local is missing - Atlas cannot reach its database without it.
)

rem --- If Atlas is already running on this port, just open the browser ---
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient('127.0.0.1',%ATLAS_PORT%)).Close();exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 (
    echo Atlas is already running - opening %ATLAS_URL%
    start "" "%ATLAS_URL%"
    goto :eof
)

rem --- Open the browser as soon as Atlas accepts connections (max ~90s) ---
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 180;$i++){try{(New-Object Net.Sockets.TcpClient('127.0.0.1',%ATLAS_PORT%)).Close();Start-Process '%ATLAS_URL%';break}catch{Start-Sleep -Milliseconds 500}}"

echo Starting Atlas at %ATLAS_URL%
echo Keep this window open while you use Atlas. Press Ctrl+C or close it to stop.
echo.
call npx next dev -p %ATLAS_PORT%

echo.
echo Atlas stopped.
pause
