// Service worker for the installed app (Chrome "Install app" / "Add to home screen").
// Request data is never cached: /api and the sign-in (/xhost-auth) always go to the network.
// Page files are fetched network-first, with the last copy as fallback; offline, a page opens a notice.

const CACHE = 'shell-v1';
const SHELL = ['/', '/styles.css', '/pages.css', '/app.js', '/activity.js', '/students.js', '/help.js', '/logo.png', '/offline.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/xhost-auth')) return;

  event.respondWith(fetch(req).then((res) => {
    if (res.ok && res.type === 'basic' && SHELL.includes(url.pathname)) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(async () => (req.mode === 'navigate'
    ? caches.match('/offline.html') // the app needs the network for every request anyway
    : (await caches.match(req, { ignoreSearch: true })) || Response.error())));
});
