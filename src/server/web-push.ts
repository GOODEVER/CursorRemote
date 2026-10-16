import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import webpush from 'web-push';
const { generateVAPIDKeys, setVapidDetails, sendNotification } = webpush;

/** A browser push subscription as produced by `PushSubscription.toJSON()`. */
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Optional label (e.g. user agent) for debugging/management. */
  label?: string;
  createdAt: number;
}

export interface WebPushConfig {
  enabled: boolean;
  /** Contact for the VAPID JWT (mailto: or https: URL). */
  subject: string;
  publicKey: string;
  privateKey: string;
}

export interface WebPushManager {
  readonly enabled: boolean;
  /** Public VAPID key the client needs to subscribe. Empty when disabled. */
  getPublicKey(): string;
  getSubscriptionCount(): number;
  addSubscription(sub: PushSubscriptionRecord): void;
  removeSubscription(endpoint: string): void;
  /**
   * Send a push to every stored subscription. Returns how many were delivered.
   * Subscriptions that the push service reports as gone (404/410) are pruned.
   * `vibrate` is a per-event-type haptic pattern the service worker applies —
   * the closest a web push can get to a distinct "sound" (platforms own the
   * actual alert tone).
   * `ttl` is the HTTP TTL in seconds (how long the push service may hold the
   * message). Defaults to a short window — the library's 4-week default was
   * delivering hours-old "Agent finished" alerts when a phone woke up.
   * `ts` is epoch-ms stamped into the payload so the service worker can also
   * drop a late delivery client-side.
   */
  send(payload: {
    title: string;
    body: string;
    tag?: string;
    vibrate?: number[];
    ttl?: number;
    ts?: number;
  }): Promise<number>;
}

/** Default TTL when the caller does not specify one (2 minutes). */
export const DEFAULT_PUSH_TTL_SEC = 120;

const MAX_SUBSCRIPTIONS = 64;

/**
 * Web Push for the mobile web client.
 *
 * Push requires a service worker + VAPID, so this is intentionally separate
 * from the in-page `Notification` API. VAPID keys are generated once and
 * persisted in the data dir (stable, so subscriptions stay valid across
 * restarts). When `enabled` is false everything is a no-op, matching the rest
 * of the server's optional transports.
 */
export function createWebPushManager(dataDir: string, subject: string, enabled: boolean): WebPushManager {
  const filePath = join(dataDir, 'push-subscriptions.json');
  const keysPath = join(dataDir, 'vapid-keys.json');

  let publicKey = '';
  let privateKey = '';
  const subscriptions = new Map<string, PushSubscriptionRecord>();

  function loadKeys(): void {
    try {
      if (existsSync(keysPath)) {
        const raw = readFileSync(keysPath, 'utf-8');
        const data = JSON.parse(raw) as { publicKey?: string; privateKey?: string };
        if (typeof data.publicKey === 'string' && typeof data.privateKey === 'string'
          && data.publicKey && data.privateKey) {
          publicKey = data.publicKey;
          privateKey = data.privateKey;
          return;
        }
      }
    } catch {
      // fall through to regeneration
    }
    const generated = generateVAPIDKeys();
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(keysPath, JSON.stringify({ publicKey, privateKey }, null, 2) + '\n', 'utf-8');
    } catch (e) {
      console.error('[web-push] Failed to persist VAPID keys:', e);
    }
  }

  function loadSubscriptions(): void {
    try {
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as { subscriptions?: unknown };
      if (!Array.isArray(data.subscriptions)) return;
      for (const s of data.subscriptions) {
        if (isSubscriptionShape(s)) subscriptions.set(s.endpoint, s);
      }
    } catch {
      // ignore corrupt or missing file
    }
  }

  function saveSubscriptions(): void {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        filePath,
        JSON.stringify({ subscriptions: [...subscriptions.values()] }, null, 2) + '\n',
        'utf-8'
      );
    } catch (e) {
      console.error('[web-push] Failed to persist push subscriptions:', e);
    }
  }

  if (enabled) {
    loadKeys();
    loadSubscriptions();
    setVapidDetails(subject, publicKey, privateKey);
    console.log(`[web-push] Enabled (${subscriptions.size} subscription(s), subject: ${subject})`);
  }

  return {
    enabled,

    getPublicKey(): string {
      return enabled ? publicKey : '';
    },

    getSubscriptionCount(): number {
      return subscriptions.size;
    },

    addSubscription(sub: PushSubscriptionRecord): void {
      if (!enabled) return;
      subscriptions.set(sub.endpoint, sub);
      while (subscriptions.size > MAX_SUBSCRIPTIONS) {
        const first = subscriptions.keys().next().value as string | undefined;
        if (first !== undefined) subscriptions.delete(first);
      }
      saveSubscriptions();
      console.log(`[web-push] Subscription stored (${subscriptions.size} total)`);
    },

    removeSubscription(endpoint: string): void {
      if (!enabled) return;
      if (subscriptions.delete(endpoint)) saveSubscriptions();
    },

    async send(payload): Promise<number> {
      if (!enabled || subscriptions.size === 0) return 0;
      const ttl = typeof payload.ttl === 'number' && payload.ttl >= 0
        ? payload.ttl
        : DEFAULT_PUSH_TTL_SEC;
      // Stamp a send time when the caller didn't, so the service worker can
      // reject a push that sat in a delivery queue past its usefulness.
      const body = JSON.stringify({
        title: payload.title,
        body: payload.body,
        tag: payload.tag,
        vibrate: payload.vibrate,
        ts: typeof payload.ts === 'number' ? payload.ts : Date.now(),
      });
      let delivered = 0;
      for (const sub of [...subscriptions.values()]) {
        try {
          await sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            body,
            { TTL: ttl, urgency: ttl <= 120 ? 'high' : 'normal' }
          );
          delivered++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // Subscription is gone — prune it.
            subscriptions.delete(sub.endpoint);
            saveSubscriptions();
          } else {
            console.warn(`[web-push] Send failed (${status ?? 'unknown'}):`, (err as Error).message);
          }
        }
      }
      return delivered;
    },
  };
}

function isSubscriptionShape(v: unknown): v is PushSubscriptionRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const keys = r.keys as Record<string, unknown> | undefined;
  return typeof r.endpoint === 'string' && r.endpoint.length > 0
    && !!keys && typeof keys.p256dh === 'string' && typeof keys.auth === 'string'
    && typeof r.createdAt === 'number';
}
