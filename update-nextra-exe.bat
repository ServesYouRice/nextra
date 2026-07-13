@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%" >nul || exit /b 1

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js was not found on PATH.
    popd >nul
    exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo npm.cmd was not found on PATH.
    popd >nul
    exit /b 1
)

if exist "%SCRIPT_DIR%cloudflared.exe" (
    set "CLOUDFLARED_PATH=%SCRIPT_DIR%cloudflared.exe"
)
echo Running the complete release gate and packaging Nextra.exe...
call npm.cmd run package
if errorlevel 1 goto :fail

echo.
echo Updated artifacts:
for %%F in ("Nextra.exe" "Nextra.exe.sha256") do (
    if exist "%%~fF" echo   %%~nxF - %%~zF bytes
)

if exist "Nextra.exe.sha256" (
    echo.
    type "Nextra.exe.sha256"
)

popd >nul
exit /b 0

:fail
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Build or packaging failed with exit code %EXIT_CODE%.
popd >nul
exit /b %EXIT_CODE%
