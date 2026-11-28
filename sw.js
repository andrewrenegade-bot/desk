// sw.js - push handler comes later (plan B pushes go through Telegram). Never caches d/ data.
self.addEventListener('install', () => self.skipWaiting());
