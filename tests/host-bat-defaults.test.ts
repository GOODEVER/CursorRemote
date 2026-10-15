import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `host-cursorremote.bat` is the supported way to host this project, and it is
 * not covered by the TypeScript build. These assertions pin the defaults that
 * make a fresh run reachable from the Cloudflare tunnel on the Debian server,
 * so a careless edit cannot silently break the public URL (cursor.tarzi.be).
 */
const bat = readFileSync(fileURLToPath(new URL('../host-cursorremote.bat', import.meta.url)), 'utf-8');

describe('host-cursorremote.bat defaults', () => {
  it('serves over HTTPS by default (required by the tunnel origin rule)', () => {
    assert.match(bat, /^set TLS_ENABLED=true\s*$/m);
    assert.match(bat, /^set TLS_CERT_PATH=data\\certs\\cert\.pem\s*$/m);
    assert.match(bat, /^set TLS_KEY_PATH=data\\certs\\key\.pem\s*$/m);
  });

  it('trusts the fronting proxy so Secure cookies and real client IPs work', () => {
    assert.match(bat, /^set TRUST_PROXY=true\s*$/m);
  });

  it('binds to all interfaces on the configured port', () => {
    assert.match(bat, /^set SERVER_HOST=0\.0\.0\.0\s*$/m);
    assert.match(bat, /^set SERVER_PORT=\d+\s*$/m);
  });

  it('declares the public URL the Debian tunnel publishes', () => {
    assert.match(bat, /^set PUBLIC_URL=https:\/\/\S+\s*$/m);
  });

  it('generates the cert with SANs for the LAN addresses and localhost', () => {
    assert.match(bat, /^:GEN_CERT\s*$/m);
    const san = bat.split('\n').find((l) => l.includes('subjectAltName'));
    assert.ok(san, 'GEN_CERT should emit a subjectAltName line');
    assert.match(san!, /IP:192\.168\.137\.1/);
    assert.match(san!, /DNS:localhost/);
  });

  it('guards on the PEM pair before generating, and never hard-fails on it', () => {
    // Missing files -> generate; generation problems leave TLS_ENABLED=false
    // rather than aborting the launch.
    assert.match(bat, /if exist "%TLS_CERT_PATH%" if exist "%TLS_KEY_PATH%" goto TLS_OK/);
    assert.match(bat, /set TLS_ENABLED=false/);
  });

  it('starts the server with a bounded heap', () => {
    assert.match(bat, /node --max-old-space-size=\d+ dist\\server\\index\.js/);
  });
});
