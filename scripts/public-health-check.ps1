<#
  One-shot health check for the public CursorRemote URL.

  Launched hidden by host-cursorremote.bat right after the relay starts.
  Silent on success (result appended to temp\public-health.log); shows a
  dialog only when the public path is broken, so a working setup adds no
  visual noise.

  Advisory only - it never affects the launcher's exit code.
#>
param(
  [Parameter(Mandatory = $true)][string]$Url
)

$ProgressPreference = 'SilentlyContinue'
$health = $Url.TrimEnd('/') + '/health'
$logDir = Join-Path $PSScriptRoot '..\temp'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir 'public-health.log'

$ok = $false
$last = 'unreachable'

# The relay binds in about a second; retry a few times in case the tunnel
# or Cloudflare edge is briefly catching up.
for ($attempt = 1; $attempt -le 3; $attempt++) {
  Start-Sleep -Seconds 8
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri $health
    $last = "HTTP $($r.StatusCode)"
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {
    if ($_.Exception.Response) {
      $last = "HTTP $([int]$_.Exception.Response.StatusCode)"
    } else {
      $last = 'unreachable'
    }
  }
}

$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
"$stamp  $health  ->  $(if ($ok) { 'OK 200' } else { "WARN $last" })" |
  Add-Content -Path $logPath -Encoding utf8

if ($ok) { exit 0 }

try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop | Out-Null
  $msg = @"
The relay is running locally, but the public URL is not reachable:

  $health  ->  $last

Things to check:
  - the Cloudflare tunnel on the Debian server is running
  - the public hostname points at this PC: https://$($Url -replace '^https?://')
  - "No TLS Verify" is enabled for the hostname in Cloudflare
    (Zero Trust -> Networks -> Tunnels -> Public Hostnames -> TLS)

See docs\https.md for the full checklist.
"@
  [System.Windows.Forms.MessageBox]::Show($msg, 'CursorRemote - public URL unreachable', 'OK', 'Warning') | Out-Null
} catch {
  # If we cannot show a dialog, leave the log file as the record.
}
exit 0
