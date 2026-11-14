@echo off
REM Builds the Windows NSIS installer.
REM
REM Why this exists instead of just `npm run dist`:
REM   * ELECTRON_RUN_AS_NODE must be cleared, otherwise electron.exe starts as
REM     plain Node and packaging/verification behaves strangely.
REM   * Every cache (npm, electron, electron-builder, NSIS) is kept inside this
REM     folder, so nothing needs write access to %LOCALAPPDATA%.
REM   * The build reuses the already-downloaded Electron runtime, so it never
REM     touches the network for a 100+ MB download again.
setlocal
cd /d "%~dp0"

set ELECTRON_RUN_AS_NODE=
set npm_config_cache=%CD%\.npm-cache
set TEMP=%CD%\.tmp
set TMP=%CD%\.tmp

REM Mirrors: only applied when not already set by the caller. Users outside the
REM mainland can delete the two MIRROR lines or run `npm run dist` directly.
if "%ELECTRON_MIRROR%"=="" set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
if "%ELECTRON_BUILDER_BINARIES_MIRROR%"=="" set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

if not exist .tmp mkdir .tmp

if not exist node_modules\electron\dist\electron.exe (
  echo [1/3] fetching electron runtime...
  node scripts\fetch-electron.js || goto :fail
)

if not exist assets\icon.png (
  echo [2/3] generating icons...
  node scripts\make-icons.js || goto :fail
)

echo [3/3] packaging...
call npx --no-install electron-builder --win nsis --config.electronDist="node_modules/electron/dist" || goto :fail

echo.
echo done: dist\
dir /b dist\*.exe
endlocal
exit /b 0

:fail
echo.
echo build failed
endlocal
exit /b 1
