// Service worker: only here to receive Web Push and focus the right session on tap.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {}
  // The home-screen icon carries the needs-you count, even with ah closed.
  const badge = Number(data.badge);
  const badged = !Number.isFinite(badge) || !('setAppBadge' in self.navigator) ? Promise.resolve() : (badge > 0 ? self.navigator.setAppBadge(badge) : self.navigator.clearAppBadge()).catch(() => {});
  event.waitUntil(
    badged.then(() => self.registration.showNotification(data.title || 'ah', {
      body: data.body || '',
      tag: data.tag,
      renotify: true,
      icon: '/icon-512.png',
      badge: '/icon-512.png',
      data: { url: data.url || '/' },
    })),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of open) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          return client.navigate(url);
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
