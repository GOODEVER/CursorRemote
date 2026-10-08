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
