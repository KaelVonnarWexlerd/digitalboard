@echo off
chcp 65001 >nul
cd /d "%~dp0"

git add .
if errorlevel 1 goto error

git diff --cached --quiet
set "DIFF_EXIT=%ERRORLEVEL%"
if "%DIFF_EXIT%"=="0" goto push
if not "%DIFF_EXIT%"=="1" goto error

git commit -m "Update website content / fix bugs"
if errorlevel 1 goto error

:push
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
