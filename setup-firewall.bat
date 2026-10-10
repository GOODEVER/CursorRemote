@echo off
title CursorRemote - one-time firewall setup

REM =====================================================================
REM  ONE-TIME setup: opens port 9301 in Windows Firewall so phones and
REM  other LAN devices can reach the CursorRemote web app.
REM  Run this once; the main host-cursorremote.bat never needs admin.
REM =====================================================================

net session >nul 2>&1
if %errorlevel%==0 goto ELEVATED

echo Requesting administrator approval (one-time)...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b 0

:ELEVATED
echo Adding firewall rule for port 9301 (TCP)...
netsh advfirewall firewall add rule name="CursorRemote 9301" dir=in action=allow protocol=TCP localport=9301
if errorlevel 1 goto FAILED

echo.
echo Done. Rule "CursorRemote 9301" created permanently.
echo You will not be asked for admin again.
echo.
pause
exit /b 0

:FAILED
echo.
echo [ERROR] Could not add the firewall rule.
pause
exit /b 1
