import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createWebappSessionStore,
  parseSessionCookie,
  WEBAPP_SESSION_COOKIE,
} from '../src/server/webapp-sessions.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'cr-sessions-'));
}

/** 64 hex chars, unique per n. */
function token(n: number): string {
  return n.toString(16).padStart(64, '0');
}

describe('webapp session store', () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('adds and recognises a session', () => {
    const s = createWebappSessionStore(dir);
    s.add(token(1));
    assert.equal(s.has(token(1)), true);
    assert.equal(s.has(token(2)), false);
  });

  it('rejects tokens that are not the expected shape', () => {
    const s = createWebappSessionStore(dir);
    s.add('too-short');
    assert.equal(s.has('too-short'), false);
    assert.equal(s.size(), 0);
  });

  it('persists sessions across instances', () => {
    const a = createWebappSessionStore(dir);
    a.add(token(1));
    a.add(token(2));

    const b = createWebappSessionStore(dir);
    assert.equal(b.has(token(1)), true);
    assert.equal(b.has(token(2)), true);
  });

  it('evicts the least-recently-used session, not the oldest-inserted', () => {
    const s = createWebappSessionStore(dir, 3);
    s.add(token(1));
    s.add(token(2));
    s.add(token(3));

    // Keep #1 alive: this is an active device that must NOT be evicted.
    assert.equal(s.has(token(1)), true);

    s.add(token(4)); // over capacity -> evict the stalest (now #2)

    assert.equal(s.has(token(1)), true, 'active session survives eviction');
    assert.equal(s.has(token(4)), true);
    assert.equal(s.has(token(2)), false, 'stale session evicted first');
  });

  it('never evicts an active device even under many new logins', () => {
    const s = createWebappSessionStore(dir, 4);
    s.add(token(100)); // the long-lived phone session
    for (let i = 0; i < 20; i++) {
      s.add(token(i));
      assert.equal(s.has(token(100)), true, 'phone session stays valid');
    }
  });

  it('loads the legacy bare-token format', () => {
    writeFileSync(
      join(dir, 'webapp-sessions.json'),
      JSON.stringify({ tokens: [token(1), token(2)] }),
      'utf-8'
    );
    const s = createWebappSessionStore(dir);
    assert.equal(s.has(token(1)), true);
    assert.equal(s.has(token(2)), true);
  });

  it('writes the new timestamped format that survives a reload', () => {
    const a = createWebappSessionStore(dir);
    a.add(token(7));
    const raw = JSON.parse(readFileSync(join(dir, 'webapp-sessions.json'), 'utf-8'));
    assert.ok(Array.isArray(raw.sessions));
    assert.equal(raw.sessions[0].token, token(7));
    assert.equal(typeof raw.sessions[0].lastSeen, 'number');

    const b = createWebappSessionStore(dir);
    assert.equal(b.has(token(7)), true);
  });

  it('ignores a corrupt sessions file', () => {
    writeFileSync(join(dir, 'webapp-sessions.json'), '{ not json', 'utf-8');
    const s = createWebappSessionStore(dir);
    assert.equal(s.size(), 0);
    s.add(token(1));
    assert.equal(s.has(token(1)), true);
  });

  it('drops sessions older than the max age on load', () => {
    const ancient = Date.now() - 200 * 24 * 60 * 60 * 1000;
    writeFileSync(
      join(dir, 'webapp-sessions.json'),
      JSON.stringify({ sessions: [{ token: token(1), lastSeen: ancient }] }),
      'utf-8'
    );
    const s = createWebappSessionStore(dir);
    assert.equal(s.size(), 0, 'expired session is dropped');
    assert.equal(existsSync(join(dir, 'webapp-sessions.json')), true);
  });
});

describe('parseSessionCookie', () => {
  it('extracts the named cookie', () => {
    assert.equal(
      parseSessionCookie(`a=1; ${WEBAPP_SESSION_COOKIE}=abc; b=2`, WEBAPP_SESSION_COOKIE),
      'abc'
    );
  });

  it('returns undefined when absent or header is missing', () => {
    assert.equal(parseSessionCookie('a=1; b=2', WEBAPP_SESSION_COOKIE), undefined);
    assert.equal(parseSessionCookie(undefined, WEBAPP_SESSION_COOKIE), undefined);
  });
});
