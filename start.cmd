@echo off
setlocal
cd /d "%~dp0"
title ZTE MF253V dashboard

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found in PATH.
  echo   Install it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

set "BIND=127.0.0.1"
set "URL=http://127.0.0.1:8787"
if /i "%~1"=="lan" (
  set "BIND=0.0.0.0"
  echo.
  echo   LAN mode: the panel will also be reachable from your phone/tablet.
  echo   The exact LAN URL is printed below after the server starts.
)

rem If the server is already listening, just open the browser.
powershell -NoProfile -Command "try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',8787); $c.Close(); exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  echo Dashboard already running. Opening %URL%
  start "" "%URL%"
  timeout /t 2 >nul
  exit /b 0
)

echo.
echo   ZTE MF253V dashboard
echo   %URL%
echo.
echo   Close this window to stop the server.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%URL%'"
set "HOST=%BIND%"
set "PORT=8787"
node server.js
echo.
echo Server stopped.
pause
