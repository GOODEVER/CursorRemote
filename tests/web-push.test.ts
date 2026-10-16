import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWebPushManager, DEFAULT_PUSH_TTL_SEC } from '../src/server/web-push.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'cr-webpush-'));
}

const SUB = {
  endpoint: 'https://push.example.com/abc',
  keys: { p256dh: 'BExampleKey', auth: 'auth-secret' },
  createdAt: 123,
};

describe('web push manager (disabled)', () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('does nothing and exposes no public key', async () => {
    const m = createWebPushManager(dir, 'mailto:test@example.com', false);
    assert.equal(m.enabled, false);
    assert.equal(m.getPublicKey(), '');
    m.addSubscription(SUB);
    assert.equal(m.getSubscriptionCount(), 0);
    assert.equal(await m.send({ title: 'x', body: 'y' }), 0);
    assert.equal(existsSync(join(dir, 'vapid-keys.json')), false);
  });
});

describe('web push manager (enabled)', () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('generates and persists VAPID keys', () => {
    const m = createWebPushManager(dir, 'mailto:test@example.com', true);
    assert.equal(m.enabled, true);
    assert.ok(m.getPublicKey().length > 0, 'public key should be non-empty');
    assert.ok(existsSync(join(dir, 'vapid-keys.json')));
    const keys = JSON.parse(readFileSync(join(dir, 'vapid-keys.json'), 'utf-8'));
    assert.equal(keys.publicKey, m.getPublicKey());
  });

  it('reuses persisted VAPID keys across instances', () => {
    const a = createWebPushManager(dir, 'mailto:test@example.com', true);
    const pub = a.getPublicKey();
    const b = createWebPushManager(dir, 'mailto:test@example.com', true);
    assert.equal(b.getPublicKey(), pub, 'keys should be stable across restarts');
  });

  it('stores, persists and reloads subscriptions', () => {
    const a = createWebPushManager(dir, 'mailto:test@example.com', true);
    a.addSubscription(SUB);
    assert.equal(a.getSubscriptionCount(), 1);
    assert.ok(existsSync(join(dir, 'push-subscriptions.json')));

    const b = createWebPushManager(dir, 'mailto:test@example.com', true);
    assert.equal(b.getSubscriptionCount(), 1, 'subscription should survive a restart');
  });

  it('removes subscriptions', () => {
    const m = createWebPushManager(dir, 'mailto:test@example.com', true);
    m.addSubscription(SUB);
    m.removeSubscription(SUB.endpoint);
    assert.equal(m.getSubscriptionCount(), 0);
  });

  it('ignores malformed subscription files', () => {
    const m = createWebPushManager(dir, 'mailto:test@example.com', true);
    m.addSubscription(SUB);
    // Corrupt the file, then a fresh instance should not throw.
    writeFileSync(join(dir, 'push-subscriptions.json'), '{ not json', 'utf-8');
    const b = createWebPushManager(dir, 'mailto:test@example.com', true);
    assert.equal(b.getSubscriptionCount(), 0);
  });

  it('uses a short default TTL (not the library four-week default)', () => {
    // Regression: the web-push library defaults to TTL=2419200 (4 weeks), so a
    // "finished" push queued while the phone was asleep could surface hours or
    // days later. We deliberately cap the default to a couple of minutes.
    assert.ok(DEFAULT_PUSH_TTL_SEC > 0);
    assert.ok(DEFAULT_PUSH_TTL_SEC <= 300, 'default TTL must be minutes, not weeks');
  });
});
