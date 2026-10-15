/* CursorRemote service worker — receives Web Push and shows notifications.
 *
 * The app itself is a live socket.io client; this worker exists so pushes can
 * be delivered (and displayed) when the page is backgrounded or closed, which
 * the in-page Notification API cannot do on mobile.
 */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/* Encode a raw key buffer as base64url, the format the relay expects. */
function b64urlFromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/*
 * Not every Chromium build implements `PushSubscription.toJSON()` (Vanadium has
 * been seen without it), so fall back to getKey() + base64url. Without this the
 * rotation handler below would throw and silently fail in exactly the case it
 * exists to fix.
 */
function subscriptionToPayload(sub) {
  if (typeof sub.toJSON === 'function') {
    try {
      const j = sub.toJSON();
      if (j && j.endpoint && j.keys && j.keys.p256dh && j.keys.auth) return j;
    } catch (_) { /* fall through to getKey */ }
  }
  const p256dh = typeof sub.getKey === 'function' ? sub.getKey('p256dh') : null;
  const auth = typeof sub.getKey === 'function' ? sub.getKey('auth') : null;
  return {
    endpoint: sub.endpoint,
    keys: {
      p256dh: p256dh ? b64urlFromBuffer(p256dh) : '',
      auth: auth ? b64urlFromBuffer(auth) : '',
    },
  };
}

/*
 * Push endpoints rotate (FCM mints a new one and the old returns 410). When the
 * browser tells us the subscription changed, re-register the new one so
 * delivery keeps working without the user having to toggle notifications.
 * Note: to recreate a subscription without a user gesture we need the VAPID
 * public key, fetched from the relay.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      let fresh = event.newSubscription;
      if (!fresh) {
        const res = await fetch('/api/push/public-key');
        const { publicKey } = await res.json();
        if (!publicKey) return;
        fresh = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey,
        });
      }
      const json = subscriptionToPayload(fresh);
      if (!json.endpoint || !json.keys.p256dh || !json.keys.auth) return;
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      });
    } catch (_) { /* best effort */ }
  })());
});

self.addEventListener('push', (event) => {
  let data = { title: 'CursorRemote', body: 'Update from your agent.', tag: 'cursor-agent' };
  try {
    if (event.data) {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    }
  } catch (_) {
    try {
      const text = event.data && event.data.text();
      if (text) data.body = text;
    } catch (__) { /* ignore */ }
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'CursorRemote', {
      body: data.body || '',
      tag: data.tag || 'cursor-agent',
      // `renotify` makes a repeat notification with the same tag alert again
      // (sound / vibration) instead of being silently coalesced into the one
      // already on screen. Without it a second "Agent finished" arrives with
      // no sound. It requires a tag, which we always set.
      renotify: true,
      // Vibration is the only per-event alert we control on a web push (the OS
      // owns the tone). Prefer the server-sent pattern; fall back to an
      // insistent triple buzz when the agent needs the user, else a single tap.
      vibrate: Array.isArray(data.vibrate)
        ? data.vibrate
        : (data.tag === 'cursor-questionnaire' || data.tag === 'cursor-approval'
          ? [200, 100, 200, 100, 200]
          : [120]),
      icon: 'favicon.png',
      badge: 'favicon.png',
      data: { url: '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
