import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** HttpOnly cookie name; must match client expectations only for non-HttpOnly flows (we use server-side parse). */
export const WEBAPP_SESSION_COOKIE = 'cursor_remote_session';

/**
 * Generous head-room. Eviction is least-recently-used (see below), so an active
 * device is never the one dropped — the cap only bounds file size. The old FIFO
 * policy (128, oldest-inserted first) could silently evict the session a phone
 * was actively using whenever new logins happened, which showed up as random
 * "it logs me out" reports.
 */
const MAX_SESSIONS = 512;
const TOKEN_HEX_LEN = 64; // randomBytes(32).toString('hex')
/** Sessions untouched for longer than this are dropped when the store loads. */
const MAX_SESSION_AGE_MS = 120 * 24 * 60 * 60 * 1000; // 120 days
/** Coalesce the frequent `has()` touches into occasional disk writes. */
const SAVE_DEBOUNCE_MS = 2_000;

export interface WebappSessionStore {
  has(token: string): boolean;
  add(token: string): void;
  size(): number;
}

/**
 * File-backed session store with least-recently-used eviction.
 *
 * `has()` is called on every authenticated HTTP request and socket handshake, so
 * it doubles as the "this session is still alive" signal: each hit moves the
 * token to the most-recently-used end. When the cap is exceeded we evict the
 * stalest token first, which keeps long-lived phone sessions alive across the
 * many transient re-logins a flaky mobile connection can produce.
 */
export function createWebappSessionStore(
  dataDir: string,
  maxSessions: number = MAX_SESSIONS
): WebappSessionStore {
  const filePath = join(dataDir, 'webapp-sessions.json');
  // token -> lastSeen (epoch ms). Map iteration order is least- to
  // most-recently-used because `touch()` re-inserts on access.
  const sessions = new Map<string, number>();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function touch(token: string): void {
    sessions.delete(token);
    sessions.set(token, Date.now());
  }

  function bufferSave(): void {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save();
    }, SAVE_DEBOUNCE_MS);
    // Never keep the process alive just to flush sessions.
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
  }

  function save(): void {
    try {
      mkdirSync(dataDir, { recursive: true });
      const payload = {
        sessions: [...sessions].map(([token, lastSeen]) => ({ token, lastSeen })),
      };
      writeFileSync(filePath, JSON.stringify(payload) + '\n', 'utf-8');
    } catch (e) {
      console.error('[relay] Failed to persist web app sessions:', e);
    }
  }

  function evictOverflow(): void {
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  }

  function load(): void {
    try {
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as { sessions?: unknown; tokens?: unknown };
      const now = Date.now();
      const entries: Array<[string, number]> = [];

      if (Array.isArray(data.sessions)) {
        for (const s of data.sessions) {
          if (!s || typeof s !== 'object') continue;
          const rec = s as { token?: unknown; lastSeen?: unknown };
          if (typeof rec.token !== 'string' || !isTokenShape(rec.token)) continue;
          const seen = typeof rec.lastSeen === 'number' && rec.lastSeen > 0 ? rec.lastSeen : now;
          entries.push([rec.token, seen]);
        }
      } else if (Array.isArray(data.tokens)) {
        // Legacy format: a bare token list. Treat file order as recency so the
        // newest entries survive best.
        const valid = data.tokens.filter(
          (t): t is string => typeof t === 'string' && isTokenShape(t)
        );
        valid.forEach((t, i) => entries.push([t, now - (valid.length - i)]));
      }

      // Oldest first so inserting in order leaves the Map LRU-ordered.
      entries.sort((a, b) => a[1] - b[1]);
      for (const [token, seen] of entries) {
        if (now - seen > MAX_SESSION_AGE_MS) continue;
        sessions.set(token, seen);
      }
      evictOverflow();
    } catch {
      // ignore corrupt or missing file
    }
  }

  load();

  return {
    has(token: string): boolean {
      if (!isTokenShape(token)) return false;
      if (!sessions.has(token)) return false;
      touch(token);
      bufferSave();
      return true;
    },
    add(token: string): void {
      if (!isTokenShape(token)) return;
      touch(token);
      evictOverflow();
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      save();
    },
    size(): number {
      return sessions.size;
    },
  };
}

function isTokenShape(s: string): boolean {
  return s.length === TOKEN_HEX_LEN && /^[a-f0-9]+$/i.test(s);
}

export function parseSessionCookie(
  cookieHeader: string | undefined,
  name: string
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === name) {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return undefined;
}
