@echo off
setlocal
echo Stopping the dashboard on port 8787...
set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  set "FOUND=1"
  echo   killing PID %%p
  taskkill /PID %%p /F >nul 2>nul
)
if not defined FOUND echo   nothing was listening on 8787.
echo Done.
timeout /t 2 >nul
