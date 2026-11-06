// Keeps the app current, and usable with no signal. It only ever touches files from this site:
// every request for another address is left alone, and nothing here can see or store your data.
// Files are asked for fresh each time (the server just says "unchanged" when they are), so a new version
// shows up the next time the app opens. The last good copy is kept only for when there is no connection.
const COPY = 'my-budget-files';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;   // not ours: the browser handles it
  event.respondWith((async () => {
    try {
      const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
      if (res.ok) (await caches.open(COPY)).put(req.url, res.clone());
      return res;
    } catch (err) {
      const saved = await caches.match(req.url);
      if (saved) return saved;
      throw err;
    }
  })());
});
