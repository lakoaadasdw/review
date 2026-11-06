@echo off
rem apiflow launcher: always run from this folder, so "node src\server.mjs" resolves.
cd /d "%~dp0"
echo [apiflow] starting on http://127.0.0.1:7788 ...
node src\server.mjs %*
echo.
echo [apiflow] server exited. Press any key to close.
pause >nul
