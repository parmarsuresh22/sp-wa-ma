@echo off
setlocal
title FOMS - Form Studio
cd /d "%~dp0"

if not defined FOMS_PORT set "FOMS_PORT=5000"
set "FOMS_URL=http://127.0.0.1:%FOMS_PORT%"

rem --- If FOMS is already running on this port, just open the browser ---
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient('127.0.0.1',%FOMS_PORT%)).Close();exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 (
    echo FOMS is already running - opening %FOMS_URL%
    start "" "%FOMS_URL%"
    goto :eof
)

rem --- Pick Python: project .venv first, then the py launcher, then python on PATH ---
set "PY="
if exist ".venv\Scripts\python.exe" (
    set "PY=.venv\Scripts\python.exe"
) else (
    where py >nul 2>&1 && set "PY=py"
)
if not defined PY (
    where python >nul 2>&1 && set "PY=python"
)
if not defined PY (
    echo [ERROR] Python was not found. Install Python 3 from https://www.python.org and try again.
    pause
    exit /b 1
)

rem --- Install dependencies on first run ---
"%PY%" -m pip show flask >nul 2>&1
if errorlevel 1 (
    echo Installing dependencies...
    "%PY%" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [ERROR] Could not install dependencies.
        pause
        exit /b 1
    )
)

rem --- Open the browser as soon as the server accepts connections (max ~30s) ---
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){try{(New-Object Net.Sockets.TcpClient('127.0.0.1',%FOMS_PORT%)).Close();Start-Process '%FOMS_URL%';break}catch{Start-Sleep -Milliseconds 500}}"

echo Starting FOMS at %FOMS_URL%
echo Keep this window open while you use FOMS. Press Ctrl+C or close it to stop.
echo.
"%PY%" "web-automation_app.py"

echo.
echo FOMS server stopped.
pause
