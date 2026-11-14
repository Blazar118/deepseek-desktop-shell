@echo off
REM Runs the smoke test outside any job object the caller may be inside.
REM Writes SMOKE_RESULT (or a failure note) to smoke-out.txt next to this file.
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
del /q smoke-out.txt 2>nul
"node_modules\electron\dist\electron.exe" . --smoke-test >> smoke-out.txt 2>&1
echo EXITCODE=%ERRORLEVEL%>> smoke-out.txt
endlocal
