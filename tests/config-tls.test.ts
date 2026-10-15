import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/server/config.js';

/**
 * `loadConfig` reads process.env directly (dotenv only fills gaps), so these
 * tests snapshot and restore the TLS-related vars around each case.
 */
const MANAGED = [
  'TLS_ENABLED',
  'TLS_CERT_PATH',
  'TLS_KEY_PATH',
  'TLS_CA_PATH',
  'TLS_KEY_PASSPHRASE',
  'TRUST_PROXY',
];

describe('config: TLS', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of MANAGED) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of MANAGED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('disables TLS by default (plain http)', () => {
    const cfg = loadConfig();
    assert.equal(cfg.tls.enabled, false);
    assert.equal(cfg.trustProxy, false);
  });

  it('enables TLS when TLS_ENABLED=true and both PEM paths are set', () => {
    process.env.TLS_ENABLED = 'true';
    process.env.TLS_CERT_PATH = 'C:\\certs\\fullchain.pem';
    process.env.TLS_KEY_PATH = 'C:\\certs\\privkey.pem';
    const cfg = loadConfig();
    assert.equal(cfg.tls.enabled, true);
    assert.equal(cfg.tls.certPath, 'C:\\certs\\fullchain.pem');
    assert.equal(cfg.tls.keyPath, 'C:\\certs\\privkey.pem');
  });

  it('stays disabled when TLS_ENABLED=true but a PEM path is missing', () => {
    process.env.TLS_ENABLED = 'true';
    process.env.TLS_CERT_PATH = 'C:\\certs\\fullchain.pem';
    // no key path
    assert.equal(loadConfig().tls.enabled, false);
  });

  it('stays disabled when paths are set but TLS_ENABLED is not true', () => {
    process.env.TLS_CERT_PATH = 'C:\\certs\\fullchain.pem';
    process.env.TLS_KEY_PATH = 'C:\\certs\\privkey.pem';
    assert.equal(loadConfig().tls.enabled, false);
  });

  it('ignores whitespace-only PEM paths', () => {
    process.env.TLS_ENABLED = 'true';
    process.env.TLS_CERT_PATH = '   ';
    process.env.TLS_KEY_PATH = '   ';
    assert.equal(loadConfig().tls.enabled, false);
  });

  it('passes through optional CA path and key passphrase', () => {
    process.env.TLS_ENABLED = 'true';
    process.env.TLS_CERT_PATH = '/certs/cert.pem';
    process.env.TLS_KEY_PATH = '/certs/key.pem';
    process.env.TLS_CA_PATH = '/certs/ca.pem';
    process.env.TLS_KEY_PASSPHRASE = 'secret';
    const cfg = loadConfig();
    assert.equal(cfg.tls.caPath, '/certs/ca.pem');
    assert.equal(cfg.tls.passphrase, 'secret');
  });

  it('reads TRUST_PROXY', () => {
    process.env.TRUST_PROXY = 'true';
    assert.equal(loadConfig().trustProxy, true);
  });
});
