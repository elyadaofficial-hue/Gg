import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

function boot() {
  const L = {}, shown = [], fetched = [], opened = [], posted = []; let focused = 0, clientList = [];
  const self = {
    location: { origin: 'https://x.netlify.app' }, addEventListener: (t, f) => (L[t] = f), skipWaiting() {}, clients: null,
    registration: { scope: 'https://x.netlify.app/', showNotification: async (t, o) => shown.push({ t, o }), pushManager: { getSubscription: async () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/E' }) } },
  };
  const ctx = { self, location: self.location, caches: { open: async () => ({}), keys: async () => [], match: async () => null }, fetch: async (u, o) => (fetched.push({ u, o }), { ok: true }), clients: { matchAll: async () => clientList, openWindow: async (u) => opened.push(u) }, URL, Response, Promise, JSON, console };
  ctx.registration = self.registration; vm.createContext(ctx); vm.runInContext(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), ctx);
  const ev = (extra) => { const p = []; return { ...extra, waitUntil: (x) => p.push(x), _p: p }; };
  return { L, shown, fetched, opened, posted, setClients: (c) => (clientList = c), ev, getFocused: () => focused };
}
test('push shows notification: same tag + renotify (no stacking), not silent, friendly Hebrew', async () => {
  const s = boot(); const e = s.ev({ data: { json: () => ({ title: 'Evening Reset 🌙', body: 'עדיין גולל? בוא נעשה את הערב קל יותר.', kind: 'first', tag: 'evening-reset', url: './index.html?reset=1&src=push' }) } });
  s.L.push(e); await Promise.all(e._p);
  const { t, o } = s.shown[0]; assert.equal(t, 'Evening Reset 🌙'); assert.equal(o.tag, 'evening-reset'); assert.equal(o.renotify, true); assert.equal(o.silent, false); assert.ok(Array.isArray(o.vibrate)); assert.equal(o.data.url, './index.html?reset=1&src=push');
});
test('garbage / empty payload still shows a safe default', async () => {
  for (const data of [{ json: () => { throw new Error('x'); } }, null]) { const s = boot(); const e = s.ev({ data }); s.L.push(e); await Promise.all(e._p); assert.equal(s.shown.length, 1); assert.match(s.shown[0].o.body, /גולל/); }
});
test('tap: cancels repeat server-side, opens the reset deep link when app closed', async () => {
  const s = boot(); let closed = false; const e = s.ev({ notification: { close: () => (closed = true), data: { url: './index.html?reset=1&src=push', kind: 'first' } } });
  s.L.notificationclick(e); await Promise.all(e._p);
  assert.ok(closed); assert.equal(s.fetched[0].u, '/api/push/cancel'); assert.equal(JSON.parse(s.fetched[0].o.body).endpoint, 'https://fcm.googleapis.com/fcm/send/E'); assert.equal(s.opened[0], 'https://x.netlify.app/index.html?reset=1&src=push');
});
test('tap with app already open: focuses it and messages it (no second window)', async () => {
  const s = boot(); let f = 0; const msgs = []; s.setClients([{ url: 'https://x.netlify.app/index.html', focus: async () => f++, postMessage: (m) => msgs.push(m) }]);
  const e = s.ev({ notification: { close() {}, data: { kind: 'repeat' } } }); s.L.notificationclick(e); await Promise.all(e._p);
  assert.equal(f, 1); assert.equal(JSON.stringify(msgs), JSON.stringify([{ type: 'open-reset' }])); assert.equal(s.opened.length, 0);
});
test('test notification does not cancel anything', async () => {
  const s = boot(); const e = s.ev({ notification: { close() {}, data: { kind: 'test' } } }); s.L.notificationclick(e); await Promise.all(e._p); assert.equal(s.fetched.length, 0);
});
test('fetch handler never caches /api/', () => {
  const s = boot(); let responded = false; const e = { request: { method: 'GET', url: 'https://x.netlify.app/api/push/config', mode: 'cors' }, respondWith: () => (responded = true) }; s.L.fetch(e); assert.equal(responded, false);
});
test('reminder notification: tapping opens the app without cancelling Evening Reset or opening the reset', async () => {
  const s = boot(); let f = 0; const msgs = []; s.setClients([{ url: 'https://x.netlify.app/index.html', focus: async () => f++, postMessage: (m) => msgs.push(m) }]);
  const e = s.ev({ notification: { close() {}, data: { kind: 'reminder', url: './index.html?src=reminder' } } }); s.L.notificationclick(e); await Promise.all(e._p);
  assert.equal(f, 1); assert.equal(msgs.length, 0); assert.equal(s.fetched.length, 0); assert.equal(s.opened.length, 0);
  const s2 = boot(); s2.setClients([]); const e2 = s2.ev({ notification: { close() {}, data: { kind: 'reminder', url: './index.html?src=reminder' } } }); s2.L.notificationclick(e2); await Promise.all(e2._p);
  assert.equal(s2.opened.length, 1); assert.ok(!String(s2.opened[0]).includes('reset=1')); assert.equal(s2.fetched.length, 0);
});
