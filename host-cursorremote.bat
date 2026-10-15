@echo off
setlocal EnableDelayedExpansion
title CursorRemote

REM =====================================================================
REM  CursorRemote - one-click host
REM  ---------------------------------------------------------------
REM  Double-click this file. It will:
REM    1. Best-effort check shortcuts + firewall (no admin, no prompts)
REM    2. Make sure the HTTPS cert exists (auto-generated, self-signed)
REM    3. Make sure Cursor is running with the debug port (auto-restarts
REM       Cursor when the port is not reachable - no prompts)
REM    4. Start the relay server (HTTPS) and open the web client
REM  One-time LAN setup: run setup-firewall.bat once if phones cannot
REM  connect. Keep this window open while you use the remote.
REM
REM  By default this hosts over HTTPS so the Cloudflare tunnel on the
REM  Debian server can pick it up and publish it on the internet at
REM  PUBLIC_URL below. See docs\https.md.
REM =====================================================================

cd /d "%~dp0"

REM ---------------- Configuration (edit here) ----------------
set CDP_URL=http://127.0.0.1:9222
set SERVER_HOST=0.0.0.0
set SERVER_PORT=9301
set WEBAPP_PASSWORD=123456
set LOG_FORMAT=text
set CURSOR_REMOTE_LICENSE_BYPASS=1
set CURSOR_EXE=C:\Program Files\cursor\Cursor.exe

REM --- HTTPS (needed for the Cloudflare tunnel / public URL) -------------
REM The Cloudflare tunnel on the Debian server targets this PC as
REM   https://192.168.1.9:9301
REM so TLS must stay enabled for PUBLIC_URL to work. The BAT generates a
REM self-signed cert for this PC's LAN IPs on first run - nothing to do by
REM hand. The tunnel accepts it because its origin rule sets noTLSVerify.
REM (SANs don't matter under noTLSVerify; delete data\certs to regenerate.)
set TLS_ENABLED=true
set TLS_CERT_PATH=data\certs\cert.pem
set TLS_KEY_PATH=data\certs\key.pem
REM Trust the fronting proxy/tunnel (Cloudflare) for X-Forwarded-* headers.
set TRUST_PROXY=true

REM --- Public URL -------------------------------------------------------
REM Hostname the Cloudflare tunnel publishes this server on. Shown in the
REM banner and health-checked at startup. Set to "" to skip.
set PUBLIC_URL=https://cursor.tarzi.be
REM ----------------------------------------------------------------------

if not exist "dist\server\index.js" goto NO_BUILD
if not exist temp mkdir temp
if not exist data mkdir data

echo =====================================================================
echo   CursorRemote setup
echo =====================================================================
echo.

REM ---------- Extract embedded PowerShell ----------
set "CR_PS=%TEMP%\cursorremote-preflight.ps1"
set "PS_LINE="
for /f "delims=:" %%N in ('findstr /n "^::PS_START" "%~f0"') do set "PS_LINE=%%N"
if not defined PS_LINE goto NO_HELPER
more +!PS_LINE! "%~f0" > "!CR_PS!"
set CR_PORT=%SERVER_PORT%
set CR_CDP=%CDP_URL%

call :PREFLIGHT

REM ---------- Fixes (best-effort, no admin/UAC prompts) ----------
REM Shortcut fixes are applied by the preflight where permissions allow.
REM Anything that needs admin is skipped silently - the launcher itself
REM restarts Cursor with the debug flag below, so no elevation is needed.

if "!SC_ADMIN!"=="1" goto SC_NEEDS_ADMIN
if "!SC_FIXED!"=="0" goto SC_OK
echo [1/5] Fixed !SC_FIXED! Cursor shortcut^(s^).
goto FW_STEP
:SC_OK
echo [1/5] Cursor shortcuts already OK.
goto FW_STEP
:SC_NEEDS_ADMIN
echo [1/5] [i] Some Cursor shortcuts could not be updated (permission).
echo       Not a problem - this launcher starts Cursor with the debug
echo       flag itself whenever the port is missing.
goto FW_STEP

:FW_STEP
if "!FW!"=="1" goto FW_OK
netsh advfirewall firewall add rule name="CursorRemote %SERVER_PORT%" dir=in action=allow protocol=TCP localport=%SERVER_PORT% >nul 2>&1
if errorlevel 1 goto FW_FAIL
echo [2/5] Firewall opened for port %SERVER_PORT%.
goto TLS_STEP
:FW_FAIL
echo [2/5] [i] Firewall rule missing and could not be added without admin.
echo       Phone/LAN devices will not connect until it exists.
echo       Run setup-firewall.bat ONCE to fix this permanently.
goto TLS_STEP
:FW_OK
echo [2/5] Firewall for port %SERVER_PORT% already OK.
goto TLS_STEP

:TLS_STEP
if /i not "%TLS_ENABLED%"=="true" goto TLS_OFF
if exist "%TLS_CERT_PATH%" if exist "%TLS_KEY_PATH%" goto TLS_OK
echo [3/5] Generating self-signed HTTPS certificate...
call :GEN_CERT
if exist "%TLS_CERT_PATH%" if exist "%TLS_KEY_PATH%" goto TLS_DONE
echo [3/5] [i] Could not generate a certificate (see message above).
echo       Falling back to plain HTTP - PUBLIC_URL will return 502.
set TLS_ENABLED=false
goto CDP_STEP
:TLS_DONE
echo [3/5] Certificate created for !LANIP!
goto CDP_STEP
:TLS_OK
echo [3/5] HTTPS certificate ready.
goto CDP_STEP
:TLS_OFF
echo [3/5] TLS disabled - serving plain HTTP.
goto CDP_STEP

:CDP_STEP
if "!CDPOK!"=="1" goto CDP_OK
echo [4/5] [i] Cursor is not exposing its debug port yet.
echo          Restarting Cursor automatically with --remote-debugging-port=9222...
goto DO_RESTART
:CDP_OK
echo [4/5] Cursor debug port is reachable.
goto SECTION4
:DO_RESTART
echo          Closing Cursor...
taskkill /IM Cursor.exe /F >nul 2>&1
timeout /t 3 /nobreak >nul
echo          Starting Cursor with remote debugging...
start "" "%CURSOR_EXE%" --remote-debugging-port=9222
timeout /t 8 /nobreak >nul
goto SECTION4

:SECTION4
set "OLD_PID="
powershell -NoProfile -Command "(Get-NetTCPConnection -State Listen -LocalPort %SERVER_PORT% -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)" > "%TEMP%\cr-pid.txt" 2>nul
for /f "delims=" %%p in (%TEMP%\cr-pid.txt) do set "OLD_PID=%%p"
if not defined OLD_PID goto LAUNCH
echo [5/5] Port %SERVER_PORT% in use ^(PID !OLD_PID!^) - stopping previous instance...
taskkill /PID !OLD_PID! /F >nul 2>&1
timeout /t 2 /nobreak >nul

:LAUNCH
set "URL_SCHEME=http"
if /i "%TLS_ENABLED%"=="true" set "URL_SCHEME=https"
echo.
echo =====================================================================
echo   CursorRemote is starting
echo ---------------------------------------------------------------------
if /i "%TLS_ENABLED%"=="true" (
  echo   TLS:      ENABLED ^(https/wss^)
) else (
  echo   TLS:      off ^(plain http^) - set TLS_ENABLED=true for https
)
echo   Local:    %URL_SCHEME%://127.0.0.1:%SERVER_PORT%
if defined LANIP echo   LAN:      %URL_SCHEME%://!LANIP!:%SERVER_PORT%
if defined PUBLIC_URL echo   Public:   %PUBLIC_URL%   ^<-- phone / internet
echo   Password: %WEBAPP_PASSWORD%
echo.
if defined PUBLIC_URL echo   The Debian server's Cloudflare tunnel forwards %PUBLIC_URL%
if defined PUBLIC_URL echo   to this PC at %URL_SCHEME%://!LANIP!:%SERVER_PORT% ^(encrypted^).
echo   Keep this window open. Press Ctrl+C or close it to stop.
echo =====================================================================
echo.

start "" cmd /c "timeout /t 3 /nobreak >nul & start "" %URL_SCHEME%://127.0.0.1:%SERVER_PORT%"
if defined PUBLIC_URL if exist "scripts\public-health-check.ps1" start "" /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "scripts\public-health-check.ps1" -Url "%PUBLIC_URL%"

node --max-old-space-size=2048 dist\server\index.js

echo.
echo Server stopped.
pause
exit /b 0

:PREFLIGHT
set FW=0
set CDPOK=0
set LANIP=
set SC_ADMIN=0
set SC_FIXED=0
for /f "usebackq tokens=1,2 delims==" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -File "!CR_PS!"`) do (
  if "%%A"=="FW" set FW=%%B
  if "%%A"=="CDP" set CDPOK=%%B
  if "%%A"=="LAN" set LANIP=%%B
  if "%%A"=="SHORTCUT_ADMIN" set SC_ADMIN=%%B
  if "%%A"=="SHORTCUT_FIXED" set SC_FIXED=%%B
)
exit /b 0

:NO_BUILD
echo [ERROR] Build not found: dist\server\index.js
echo Run "npm run build" first.
echo.
pause
exit /b 1

:NO_HELPER
echo [ERROR] Could not prepare setup helper.
pause
exit /b 1

REM ---- Generate / renew the self-signed HTTPS cert for the LAN IPs ----
REM Writes a minimal openssl config and asks Git's openssl to self-sign it.
REM Idempotent: callers guard on the PEM files already existing.
:GEN_CERT
if not exist "data\certs" mkdir "data\certs"
set "SSL_IPS="
if defined LANIP set "SSL_IPS=IP:!LANIP!, "
> "data\certs\openssl.cnf" echo [req]
>>"data\certs\openssl.cnf" echo distinguished_name = dn
>>"data\certs\openssl.cnf" echo x509_extensions = v3
>>"data\certs\openssl.cnf" echo prompt = no
>>"data\certs\openssl.cnf" echo [dn]
>>"data\certs\openssl.cnf" echo CN = CursorRemote
>>"data\certs\openssl.cnf" echo [v3]
>>"data\certs\openssl.cnf" echo subjectAltName = !SSL_IPS!IP:192.168.137.1, DNS:localhost
>>"data\certs\openssl.cnf" echo basicConstraints = critical, CA:FALSE
>>"data\certs\openssl.cnf" echo keyUsage = critical, digitalSignature, keyEncipherment
>>"data\certs\openssl.cnf" echo extendedKeyUsage = serverAuth
set "CR_OPENSSL="
if exist "C:\Program Files\Git\usr\bin\openssl.exe" set "CR_OPENSSL=C:\Program Files\Git\usr\bin\openssl.exe"
if not defined CR_OPENSSL for /f "delims=" %%o in ('where openssl 2^>nul') do if not defined CR_OPENSSL set "CR_OPENSSL=%%o"
if not defined CR_OPENSSL goto GEN_NO_OPENSSL
"%CR_OPENSSL%" req -x509 -newkey rsa:2048 -keyout "data\certs\key.pem" -out "data\certs\cert.pem" -days 3650 -nodes -config "data\certs\openssl.cnf" 2>nul
if errorlevel 1 goto GEN_FAIL
exit /b 0
:GEN_NO_OPENSSL
echo         openssl not found. Install Git for Windows, or generate the cert
echo         manually (see docs\https.md).
exit /b 0
:GEN_FAIL
echo         openssl could not create the certificate (see docs\https.md).
exit /b 0

::PS_START
$ErrorActionPreference = 'SilentlyContinue'
$port = $env:CR_PORT
$cdp  = $env:CR_CDP

$flag = '--remote-debugging-port=9222'
$ws = New-Object -ComObject WScript.Shell
$roots = @(
  "$env:USERPROFILE\Desktop",
  "$env:PUBLIC\Desktop",
  "$env:APPDATA\Microsoft\Windows\Start Menu",
  "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch",
  "$env:LOCALAPPDATA\Microsoft\Windows\Application Shortcuts"
)
$needsAdmin = $false
$fixed = 0
foreach ($r in $roots) {
  if (-not (Test-Path $r)) { continue }
  foreach ($lnk in (Get-ChildItem $r -Recurse -Filter *.lnk)) {
    $s = $null
    try { $s = $ws.CreateShortcut($lnk.FullName) } catch { $needsAdmin = $true; continue }
    if ($s -eq $null) { continue }
    if ($s.TargetPath -match 'Cursor\.exe' -and $s.Arguments -notmatch 'remote-debugging-port') {
      try { $s.Arguments = ($s.Arguments + ' ' + $flag).Trim(); $s.Save(); $fixed++ }
      catch { $needsAdmin = $true }
    }
  }
}

$fw = 0
if (Get-NetFirewallRule -DisplayName "CursorRemote $port" -ErrorAction SilentlyContinue) { $fw = 1 }

$cdpOk = 0
try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$cdp/json/version").StatusCode -eq 200) { $cdpOk = 1 } } catch { }

$lan = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Where-Object { $_.InterfaceAlias -notmatch 'Loopback|Bluetooth|vEthernet|Hyper-V|WSL|Virtual|VPN|TUN|Tailscale|ZeroTier|Radmin|Docker' } |
  Sort-Object -Property @{ Expression = { if ($_.IPAddress -like '192.168.*') { 0 } elseif ($_.IPAddress -like '10.*') { 1 } else { 2 } } }, @{ Expression = { $_.InterfaceAlias } } |
  Select-Object -First 1 -ExpandProperty IPAddress
if (-not $lan) {
  $lan = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -First 1 -ExpandProperty IPAddress
}

Write-Output "FW=$fw"
Write-Output "CDP=$cdpOk"
Write-Output "LAN=$lan"
if ($needsAdmin) { Write-Output "SHORTCUT_ADMIN=1" } else { Write-Output "SHORTCUT_ADMIN=0" }
Write-Output "SHORTCUT_FIXED=$fixed"
exit 0