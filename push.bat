@echo off
chcp 65001 >nul
cd /d "%~dp0"

git add .
if errorlevel 1 goto error

git commit -m "更新網站內容 / 修復 Bug"
if errorlevel 1 goto error

git push origin main
if errorlevel 1 goto error

echo.
echo Push completed.
pause
exit /b 0

:error
echo.
echo Git command failed.
pause
exit /b 1
