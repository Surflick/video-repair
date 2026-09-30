@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo Node.js 18 or newer is required.
  echo Install it from https://nodejs.org
  echo Then double-click this file again.
  echo.
  pause
  exit /b 1
)

node scripts\launch.js
if errorlevel 1 pause
