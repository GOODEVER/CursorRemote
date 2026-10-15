# HTTPS and the Cloudflare Tunnel

`cursor.tarzi.be` is served by the **remote-controlled Cloudflare Tunnel that runs on the
Debian server**. That tunnel's ingress rule targets this Windows PC:

```
cursor.tarzi.be → https://192.168.1.9:9301
```

Note the **`https://`**. The relay must therefore speak TLS, or the tunnel's handshake
fails and Cloudflare returns **502 Bad Gateway**.

## The end-to-end path

```
phone ──HTTPS──> Cloudflare edge ──tunnel──> cloudflared (Debian) ──HTTPS──> relay (Windows :9301)
        (Universal SSL, trusted)                (noTLSVerify)          (self-signed cert)
```

- **Browser ↔ Cloudflare** uses Universal SSL — real, trusted, no warnings. This is what
  gives the phone a secure context (Web Push, install-to-homescreen).
- **Debian ↔ Windows** is the "LAN hop" this doc is about, and it is encrypted with the
  self-signed cert in `data/certs/`.

## Windows side (automatic)

`host-cursorremote.bat` is built for this path out of the box — double-clicking it is all
that is needed:

1. **The HTTPS cert is generated for you.** On first run the BAT writes
   `data\certs\openssl.cnf` and calls Git's `openssl` to self-sign a 10-year cert with
   SANs for the LAN addresses the server may be reached at:

   ```
   subject = CN=CursorRemote
   SAN     = IP:192.168.1.9, IP:192.168.137.1, DNS:localhost
   ```

   `data/certs/` is gitignored, so this is per-machine and never committed. Because the
   cert is self-signed, the tunnel does **not** verify it (`noTLSVerify`), so the LAN hop
   is encrypted but not authenticated — acceptable for a direct home-LAN link. To
   regenerate, delete `data\certs\` and run the BAT again.

   If `openssl` cannot be found the BAT falls back to plain HTTP and says so; the public
   URL then returns 502 until a cert exists.

2. **The BAT sets the required config:**

   ```bat
   set TLS_ENABLED=true
   set TLS_CERT_PATH=data\certs\cert.pem
   set TLS_KEY_PATH=data\certs\key.pem
   set TRUST_PROXY=true
   set PUBLIC_URL=https://cursor.tarzi.be
   ```

   `TRUST_PROXY=true` makes the relay honour Cloudflare's `X-Forwarded-*` headers so the
   login rate limiter sees real client IPs and the session cookie is marked `Secure`.
   `PUBLIC_URL` is shown in the startup banner and health-checked after launch.

3. **Startup health check.** After the relay starts, the BAT launches
   `scripts/public-health-check.ps1` hidden. It is silent when the public URL answers
   `200` (the result is appended to `temp\public-health.log`); if the public path is
   broken it pops a dialog naming the failing check and points back here.

## Cloudflare dashboard change (required once)

The tunnel is **remotely managed**, so its rules live in Cloudflare, not in any file on
either machine. Enable the "No TLS Verify" toggle for this hostname:

**Zero Trust → Networks → Tunnels → `<your tunnel>` → Public Hostnames →
`cursor.tarzi.be` → Edit:**

| Field | Value |
|-------|-------|
| Subdomain | `cursor` |
| Domain | `tarzi.be` |
| Service Type | **HTTPS** |
| URL | `192.168.1.9:9301` |

Then expand **Additional application settings → TLS** and turn on **No TLS Verify**.

The equivalent API field, for reference:

```json
{
  "hostname": "cursor.tarzi.be",
  "service": "https://192.168.1.9:9301",
  "originRequest": { "noTLSVerify": true }
}
```

Without `noTLSVerify`, cloudflared rejects the self-signed cert and the public URL keeps
returning 502.

### Verify the rule actually propagated

Ingress rules are re-published within a minute or two. The live, authoritative rule set is
logged by the connector:

```bash
ssh debian "docker logs cloudflared 2>&1 | grep -o 'Updated to new configuration.*' | tail -1"
```

Look for `noTLSVerify` on the `cursor.tarzi.be` entry.

## Testing the LAN hop directly

From the Debian server (simulating what cloudflared does):

```bash
ssh debian "curl -k -s -o /dev/null -w '%{http_code}\n' https://192.168.1.9:9301/health"
```

`200` means the hop is healthy. Without `-k` you will get
`SSL routines::wrong version number` if the relay is still serving plain HTTP — that is
the signature of a TLS client hitting a non-TLS server.

## Regenerating the cert

The BAT creates the cert automatically. To force a fresh one (new LAN IP, or an expired
cert), just delete the folder and run the launcher again:

```powershell
Remove-Item data\certs -Recurse -Force
# double-click host-cursorremote.bat -> "[3/5] Generating self-signed HTTPS certificate..."
```

Or do it by hand (Git for Windows ships the needed `openssl`):

```powershell
New-Item -ItemType Directory -Force -Path data\certs | Out-Null
@"
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = CursorRemote
[v3]
subjectAltName = IP:192.168.1.9, IP:192.168.137.1, DNS:localhost
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
"@ | Set-Content -Path data\certs\openssl.cnf -Encoding ascii

& "C:\Program Files\Git\usr\bin\openssl.exe" req -x509 -newkey rsa:2048 `
  -keyout data\certs\key.pem -out data\certs\cert.pem `
  -days 3650 -nodes -config data\certs\openssl.cnf
```

Then restart the launcher. `noTLSVerify` accepts any cert, so no Cloudflare change is
needed.

## Trade-offs to be aware of

- **Direct LAN access now uses HTTPS too.** `http://192.168.1.9:9301` no longer answers;
  use `https://192.168.1.9:9301` (self-signed warning) or, better,
  `https://cursor.tarzi.be` from any device.
- **The LAN hop is encrypted but not authenticated** (`noTLSVerify`). Traffic is protected
  from passive sniffing; it is not protected against an active attacker already on the LAN.
  For the strongest option, use a Cloudflare **Origin CA** cert and drop `noTLSVerify`.
