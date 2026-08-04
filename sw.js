// dashboard/sw.js
//
// Service worker for staff-portal Web Push (chat + calls). This file has
// exactly two jobs:
//   1. Receive a push event from the browser's push service and show an
//      OS-level notification from it — this is the part that works even
//      when no dashboard tab is open, which is the whole point.
//   2. Handle a click on that notification: focus an already-open
//      dashboard tab if there is one, otherwise open a new one, at the
//      URL the push payload asked for.
//
// It does NOT handle subscribing (that's pushSubscribeIfNeeded() in
// dashboard.html, which needs a user gesture + Notification.requestPermission()
// and so has to run in the page, not here) and does NOT do any WebRTC/call
// signaling itself — a service worker can't join a live call; its job for
// an incoming-call push is purely "get the person's attention and send them
// back to the tab", where the existing call UI (already wired to Realtime)
// takes over exactly as if they'd had the tab open the whole time.
//
// HOSTING: this file must be served from the SAME origin as dashboard.html,
// and its scope covers whatever directory it's served from (register it
// with an explicit `scope` from dashboard.html — see pushSubscribeIfNeeded()
// — if you want it to cover paths outside its own directory). Simplest
// setup: serve this file at your site root (e.g. https://app.yourdomain.com/sw.js)
// so its default scope is "everything on this origin", regardless of which
// subpath dashboard.html itself lives at.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'PropTech AI', body: event.data ? event.data.text() : 'New notification' };
  }

  const title = data.title || 'PropTech AI';
  const options = {
    body: data.body || '',
    tag: data.tag || 'proptech-ai',
    // v127: same tag replaces the previous notification instead of
    // stacking (e.g. three quick messages in the same thread collapse to
    // the latest one) UNLESS this is a call, where each ring genuinely is
    // a new event worth its own alert.
    renotify: !!data.requireInteraction,
    requireInteraction: !!data.requireInteraction,
    data: { url: data.url || '/' },
    icon: data.icon || '/dashboard/icon128.png',
    badge: data.badge || '/dashboard/icon128.png',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        // Reuse an already-open dashboard tab if we have one — focusing
        // beats opening a duplicate.
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client && targetUrl) {
            try { client.navigate(targetUrl); } catch (e) { /* ignore, focus alone still helps */ }
          }
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    }),
  );
});
