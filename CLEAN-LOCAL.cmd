@echo off
setlocal
cd /d "%~dp0"
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  powershell.exe -NoLogo -NoProfile -File "%~dp0scripts\clean-local.ps1"
) else (
  pwsh.exe -NoLogo -NoProfile -File "%~dp0scripts\clean-local.ps1"
)
set "cleanup_result=%errorlevel%"
echo.
if not "%cleanup_result%"=="0" echo Cleanup did not complete. Read the errors above.
pause
exit /b %cleanup_result%
