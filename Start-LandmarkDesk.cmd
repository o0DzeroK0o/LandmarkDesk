@echo off
setlocal
title LandmarkDesk
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
if errorlevel 1 (
  echo.
  echo LandmarkDesk could not start. Read the message above and retry.
  pause
  exit /b 1
)
