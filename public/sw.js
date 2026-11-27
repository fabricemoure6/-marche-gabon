/* Marché Gabon — service worker de l'application installable.
   - Pages : réseau d'abord (toujours à jour), copie de secours si la connexion tombe, sinon page « hors connexion ».
   - Fichiers du site (styles, scripts, images) : affichés tout de suite depuis la copie, mis à jour en arrière-plan.
   - Photos des produits (/api/photos/…) : gardées en copie (elles ne changent jamais pour un même identifiant).
   - Toutes les autres données (/api/…) : jamais gardées, pour ne rien laisser de personnel sur le téléphone.
   Cloudflare redirige « /page.html » vers « /page » : une réponse redirigée ne peut pas servir une page hors connexion,
   on en garde donc une copie « propre », rangée sous les deux adresses.
   Notifications push : affichées comme celles d'une application, même site fermé ; un toucher ouvre la bonne page. */
const VERSION = 'mg-v1';
const STATIC = VERSION + '-site', PAGES = VERSION + '-pages', PHOTOS = VERSION + '-photos';
const CORE_PAGES = ['/', '/offline.html'];
const CORE_FILES = ['/styles.css', '/looks.css', '/common.js', '/manifest.webmanifest', '/img/icon-192.png', '/img/icon-512.png', '/favicon.svg'];
const MAX_PHOTOS = 300, MAX_PAGES = 40;

const clean = async res => (res.redirected ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers }) : res);
const variants = u => { const p = new URL(u, location.origin).pathname; return p.endsWith('.html') ? [p, p.slice(0, -5)] : p === '/' ? [p] : [p, p + '.html']; };
async function putPage(cache, reqUrl, res) {
  const c = await clean(res);
  const keys = new Set([...variants(reqUrl), ...variants(res.url || reqUrl)]);
  for (const k of keys) await cache.put(k, c.clone());
}
async function trim(cacheName, max) {
  const c = await caches.open(cacheName), keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const site = await caches.open(STATIC);
    await site.addAll(CORE_FILES);
    for (const p of CORE_PAGES) { const r = await fetch(p); if (r.ok) await putPage(site, p, r); }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// ---------- Notifications push ----------
const URGENT = ['order', 'courier', 'payment'];
// iPhone, iPad et Mac (Safari) exigent une notification visible à chaque message, sinon ils coupent l'abonnement
const SAFARI = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Firefox|Android/.test(navigator.userAgent);
self.addEventListener('push', e => {
  let n = {};
  try { n = e.data ? e.data.json() : {}; } catch { n = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) w.postMessage({ type: 'mg-push', n }); // site ouvert : il joue tout de suite le son fort choisi
    // Site au premier plan : le son et le message du site suffisent (Safari exige quand même une notification)
    if (!SAFARI && wins.some(w => w.focused && w.visibilityState === 'visible')) return;
    const urgent = URGENT.includes(n.kind);
    await self.registration.showNotification(n.title || 'Marché Gabon', {
      body: n.body || '', icon: '/img/icon-192.png', badge: '/img/badge-96.png', lang: 'fr', dir: 'ltr',
      tag: n.id || undefined, renotify: !!n.id, silent: false, requireInteraction: urgent, timestamp: Date.now(),
      vibrate: urgent ? [600, 200, 600, 200, 600, 200, 1000] : [300, 120, 300],
      data: { url: n.url || '/' }
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', location.origin);
  const target = url.origin === location.origin ? url.href : location.origin + '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find(c => new URL(c.url).origin === location.origin);
    if (w) { await w.focus(); try { await w.navigate(target); } catch { /* page non contrôlée */ } return; }
    await self.clients.openWindow(target);
  })());
});
// Le navigateur a renouvelé l'abonnement : on prévient le serveur
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const old = e.oldSubscription, key = old && old.options && old.options.applicationServerKey;
    if (!key) return;
    const sub = e.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf': '1' }, body: JSON.stringify(sub) });
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // le reste passe directement au réseau

  // Photos : copie d'abord, réseau sinon
  if (/^\/api\/photos\/[a-f0-9]{16}$/.test(url.pathname)) {
    e.respondWith(caches.open(PHOTOS).then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { c.put(req, res.clone()); trim(PHOTOS, MAX_PHOTOS); }
      return res;
    }));
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return; // données : toujours en direct

  // Pages : réseau d'abord, puis copie, puis page hors connexion
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') { const c = await caches.open(PAGES); putPage(c, req.url, res.clone()).then(() => trim(PAGES, MAX_PAGES)); }
        return res;
      } catch {
        for (const k of [req.url, ...variants(req.url)]) { const hit = await caches.match(k); if (hit) return hit; }
        return (await caches.match('/offline.html')) || new Response('<h1>Pas de connexion</h1>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  // Fichiers du site : copie tout de suite, mise à jour en arrière-plan
  e.respondWith(caches.open(STATIC).then(async c => {
    const hit = await c.match(req);
    const fresh = fetch(req).then(res => { if (res.ok && res.type === 'basic') c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});
