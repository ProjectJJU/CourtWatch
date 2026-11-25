@echo off
cd /d "%~dp0web"
where python >nul 2>&1
if errorlevel 1 (
  echo python 을 찾지 못했습니다.
  pause
  exit /b 1
)
echo http://127.0.0.1:8765/
start "" http://127.0.0.1:8765/
python -m http.server 8765
