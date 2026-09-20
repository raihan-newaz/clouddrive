@echo off
title CloudDrive Windows Desktop...
cd /d "%~dp0"

if exist "Desktop application\CloudDrive.exe" (
    start "" "Desktop application\CloudDrive.exe"
) else if exist "Desktop application\dist\CloudDrive.exe" (
    start "" "Desktop application\dist\CloudDrive.exe"
) else (
    cd "Desktop application"
    call build.bat
    if exist "CloudDrive.exe" start "" "CloudDrive.exe"
)
