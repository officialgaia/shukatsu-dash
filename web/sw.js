// Service Worker
// ・オフライン表示：同じオリジンの GET は「ネット優先、つながらなければキャッシュ」。
//   plan.json を直したときもすぐ反映され、圏外でも前回の画面が出る。
// ・プッシュ通知：Worker から届いた通知を表示し、タップで該当の画面を開く。
const CACHE = 'shukatsu-v9';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/util.js',
  './js/chart.js',
  './js/sync.js',
  './js/ai.js',
  './js/notify.js',
  './data/config.json',
  './data/plan.json',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    // 毎回サーバーに確かめる（変わっていなければ 304 で軽い）。
    // ブラウザの HTTP キャッシュに古い JS が残って、新旧のファイルが混ざるのを防ぐ
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
  );
});

// ---------- プッシュ通知 ----------
self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { body: e.data ? e.data.text() : '' };
  }
  const title = data.title || '就活ボード';
  e.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: './icons/icon-192.png',
      tag: data.tag || 'shukatsu',
      renotify: !!data.tag,
      lang: 'ja',
      data: { url: data.url || './#/home' },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './#/home', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      // すでに開いていれば、その画面を前に出して移動する
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
          await c.focus();
          if ('navigate' in c) return c.navigate(url).catch(() => c);
          return c;
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

// 端末側で購読が更新されたとき（ブラウザが鍵を入れ替えた等）は、次にアプリを開いたときに登録し直す。
self.addEventListener('pushsubscriptionchange', () => {
  self.registration.showNotification('就活ボード', {
    body: '通知の設定が切れました。アプリを開いて、設定から通知をオンにし直してください。',
    icon: './icons/icon-192.png',
    tag: 'resubscribe',
  });
});
