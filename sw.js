// Service Worker：快取網頁本身，讓車上沒網路時也能打開
// 音樂檔不經過這裡（存在 IndexedDB）
const CACHE = 'car-music-v1';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './player.js', './db.js', './drive.js', './auth.js', './config.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 網路優先（拿到最新版），3 秒內沒回應或離線就用快取
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = new URL(req.url);
    key.search = ''; // ?autoplay=1 之類的參數共用同一份快取
    const network = fetch(req).then(res => {
      if (res.ok) cache.put(key.href, res.clone());
      return res;
    });
    const timeout = new Promise(resolve => setTimeout(resolve, 3000));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch { /* 離線 */ }
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    return network; // 快取也沒有，就繼續等網路
  })());
});
