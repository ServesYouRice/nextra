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

rem Windows locks a running executable. The packager moves the locked file aside
rem so the build still succeeds, but the running app keeps the old code until it
rem is restarted - which reads exactly like "the update did nothing".
set "NEXTRA_WAS_RUNNING="
tasklist /fi "imagename eq Nextra.exe" 2>nul | find /i "Nextra.exe" >nul
if not errorlevel 1 set "NEXTRA_WAS_RUNNING=1"

rem Deliberately NOT setting CLOUDFLARED_PATH. That variable is a hard override:
rem the packager fails outright when the file it points at is not the pinned,
rem signed cloudflared asset. A stale local cloudflared.exe therefore broke every
rem build. Left unset, the packager downloads and verifies the pinned asset.
set "CLOUDFLARED_PATH="

rem The release gate runs step by step instead of via `npm run package` so a
rem failure names the stage that broke. Packaging leaves the previous
rem Nextra.exe untouched when a gate fails, which otherwise looks like a
rem successful update.
call :gate lint            || goto :fail
call :gate typecheck       || goto :fail
call :gate test            || goto :fail
call :gate test:coverage   || goto :fail
call :gate build           || goto :fail
call :gate evaluate:packaging || goto :fail
call :gate oss:check       || goto :fail
call :gate audit:prod      || goto :fail

echo.
echo [package] Packaging Nextra.exe...
set "FAILED_STAGE=package:artifact"
call npm.cmd run package:artifact
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

if defined NEXTRA_WAS_RUNNING (
    echo.
    echo ==========================================================
    echo   Nextra.exe was running during this build.
    echo   CLOSE AND REOPEN IT to actually run the new build.
    echo ==========================================================
)

popd >nul
exit /b 0

:gate
echo.
echo [gate] %~1
set "FAILED_STAGE=%~1"
call npm.cmd run %~1
exit /b %ERRORLEVEL%

:fail
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo ==========================================================
echo   FAILED at stage: %FAILED_STAGE%  (exit code %EXIT_CODE%)
echo   Nextra.exe was NOT rebuilt and still holds the old build.
echo   Scroll up to the [gate] %FAILED_STAGE% banner for details.
echo ==========================================================
popd >nul
exit /b %EXIT_CODE%
