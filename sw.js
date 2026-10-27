// sw.js — service worker: офлайн-режим и кеш приложения

const VERSION = 'rs-v1.0.0';
const CACHE = `ringtone-studio-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/ui.js',
  './js/db.js',
  './js/engine.js',
  './js/id3.js',
  './js/library.js',
  './js/player.js',
  './js/editor.js',
  './js/export.js',
  './js/ringtones.js',
  './js/mp3-worker.js',
  './lib/lame.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const resp = await fetch(req);
      if (resp && resp.ok && resp.type === 'basic') cache.put(req, resp.clone());
      return resp;
    } catch {
      if (req.mode === 'navigate') {
        return (await cache.match('./')) || (await cache.match('./index.html')) || Response.error();
      }
      return Response.error();
    }
  })());
});
