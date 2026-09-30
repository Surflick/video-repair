@echo off
setlocal
cd /d "%~dp0"

set "VENDOR=%~dp0vendor\win-x64"
if exist "%VENDOR%\node.exe" (
  set "PATH=%VENDOR%;%PATH%"
  set "FFMPEG_PATH=%VENDOR%\ffmpeg.exe"
  set "FFPROBE_PATH=%VENDOR%\ffprobe.exe"
  "%VENDOR%\node.exe" "%~dp0scripts\launch.js"
  if errorlevel 1 pause
  exit /b
)

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo Node.js 18 or newer is required.
  echo Install it from https://nodejs.org
  echo Or download the Windows zip from the Video Repair GitHub release.
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\launch.js"
if errorlevel 1 pause
