@echo off
rem GCIO Project Intelligence — one-click launcher
cd /d "%~dp0"
if not exist client\dist\index.html (
  echo Building web client...
  call npm run build || (echo Build failed & pause & exit /b 1)
)
echo Starting GCIO Project Intelligence on http://localhost:8123 ...
start "" http://localhost:8123
node server\index.js
pause
