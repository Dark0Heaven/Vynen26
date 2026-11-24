// Service Worker: hält die App-Dateien offline vor. Daten (Supabase) laufen immer übers Netz.
const CACHE = 'vynen-v50';
const FILES = ['./', './index.html', './css/app.css', './js/app.js', './js/scorer.js', './js/rules.js',
  './js/db.js', './js/config.js', './js/admin.js', './js/data.js', './js/views.js', './js/swiss.js', './js/theme.js', './js/extra.js', './js/cricket.js', './js/camera.js', './js/autodarts.js', './js/games.js', './js/me.js', './img/qr-live.png', './img/bigfish.png', './img/vynen26.png', './img/fav-vynen.png', './img/fav-bigfish.png', './manifest.webmanifest', './manifest-bigfish.webmanifest', './img/app-vynen-180.png', './img/app-vynen-192.png', './img/app-vynen-512.png', './img/app-bigfish-180.png', './img/app-bigfish-192.png', './img/app-bigfish-512.png', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Netz zuerst (immer aktuelle Version), bei Offline aus dem Cache
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.endsWith('supabase.co')) return;
  e.respondWith(
    fetch(url.origin === location.origin ? new Request(e.request, { cache: 'no-cache' }) : e.request).then(r => {
      if (r.ok && (url.origin === location.origin || url.hostname.includes('jsdelivr') || url.hostname.includes('gstatic') || url.hostname.includes('googleapis'))) {
        const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return r;
    }).catch(() => caches.match(e.request).then(m => m || caches.match('./index.html')))
  );
});

// Push: „Mein Spieler“ (Edge Function notify)
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Vynen 26', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Vynen 26', {
    body: d.body || '', tag: d.tag, renotify: true, icon: './img/app-vynen-192.png', badge: './img/fav-vynen.png',
    data: { url: d.url || '#live' }, vibrate: [200, 100, 200] }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL('./' + (e.notification.data && e.notification.data.url || ''), self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope)) { c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
