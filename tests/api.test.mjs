import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setStoreForTests, memoryStore } from '../netlify/lib/store.mjs';
import api, { config } from '../netlify/functions/push-api.mjs';
import tickFn, { config as tickCfg } from '../netlify/functions/push-tick.mjs';
import worker from '../ai-proxy/worker.js';
import { b64u } from '../netlify/lib/webpush.mjs';

const O = 'https://site.netlify.app';
const req = (path, method = 'GET', body, origin = O) => new Request(O + path, { method, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: body ? JSON.stringify(body) : undefined });
test('config exports: routed path and every-minute schedule', () => { assert.equal(config.path, '/api/push/*'); assert.equal(tickCfg.schedule, '* * * * *'); });
test('push-api: config 503 without keys, 200 with', async () => {
  delete process.env.VAPID_PUBLIC_KEY; assert.equal((await api(req('/api/push/config'))).status, 503);
  process.env.VAPID_PUBLIC_KEY = 'PUB'; const r = await api(req('/api/push/config')); assert.equal(r.status, 200); assert.equal((await r.json()).publicKey, 'PUB');
});
test('push-api: cross-origin, GET on POST routes, unknown route, bad json', async () => {
  assert.equal((await api(req('/api/push/subscribe', 'POST', {}, 'https://evil.com'))).status, 403);
  assert.equal((await api(req('/api/push/subscribe', 'GET'))).status, 405);
  assert.equal((await api(req('/api/push/nope', 'POST', {}))).status, 404);
  assert.equal((await api(new Request(O + '/api/push/subscribe', { method: 'POST', body: 'x' }))).status, 400);
});
test('push-api: subscribe -> cancel -> skip -> unsubscribe lifecycle', async () => {
  setStoreForTests(memoryStore()); const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: b64u.enc(ua.getPublicKey()), auth: b64u.enc(crypto.randomBytes(16)) } };
  assert.equal((await api(req('/api/push/subscribe', 'POST', { subscription: { ...sub, endpoint: 'https://evil.com/x' }, settings: {} }))).status, 400);
  const r = await api(req('/api/push/subscribe', 'POST', { subscription: sub, settings: { enabled: true, time: '22:30', tz: 'Asia/Jerusalem' } })); assert.equal(r.status, 200); assert.equal((await r.json()).settings.repeatMin, 20);
  assert.equal((await api(req('/api/push/cancel', 'POST', { endpoint: sub.endpoint }))).status, 200);
  assert.equal((await api(req('/api/push/skip', 'POST', { endpoint: sub.endpoint }))).status, 200);
  assert.equal((await api(req('/api/push/cancel', 'POST', { endpoint: 'https://fcm.googleapis.com/fcm/send/unknown' }))).status, 404);
  assert.equal((await api(req('/api/push/unsubscribe', 'POST', { endpoint: sub.endpoint }))).status, 200);
  assert.equal((await api(req('/api/push/cancel', 'POST', { endpoint: sub.endpoint }))).status, 404);
});
test('push-api: subscription cap', async () => {
  setStoreForTests(memoryStore()); const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); let last;
  for (let i = 0; i < 27; i++) last = await api(req('/api/push/subscribe', 'POST', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/' + i, keys: { p256dh: b64u.enc(ua.getPublicKey()), auth: b64u.enc(crypto.randomBytes(16)) } }, settings: {} }));
  assert.equal(last.status, 429);
});
test('tick function runs without VAPID keys (no crash)', async () => { setStoreForTests(memoryStore()); delete process.env.VAPID_PRIVATE_KEY; await tickFn(); });

// AI worker
const env = { GEMINI_API_KEY: 'k', ALLOWED_ORIGIN: O };
const wreq = (b, origin = O) => new Request('https://w.example/', { method: 'POST', headers: { Origin: origin, 'content-type': 'application/json' }, body: JSON.stringify(b) });
const withGemini = async (out, fn) => { const real = globalThis.fetch; let seen; globalThis.fetch = async (u, o) => { seen = JSON.parse(o.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] })); }; try { return await fn(() => seen); } finally { globalThis.fetch = real; } };
test('worker: wrong origin forbidden; legacy {text} unchanged; label & catchup modes', async () => {
  assert.equal((await worker.fetch(wreq({ text: 'x' }, 'https://evil.com'), env)).status, 403);
  await withGemini({ items: [{ name: 'a' }] }, async () => { const r = await worker.fetch(wreq({ text: 'אורז' }), env); assert.deepEqual(await r.json(), { items: [{ name: 'a' }] }); });
  await withGemini({ readable: true, per100: { calories: 1 } }, async (seen) => {
    const r = await worker.fetch(wreq({ mode: 'label', image: 'QUJD', mime: 'image/jpeg' }), env); assert.equal(r.status, 200); assert.equal((await r.json()).readable, true);
    assert.equal(seen().contents[0].parts[1].inlineData.mimeType, 'image/jpeg'); assert.match(seen().contents[0].parts[0].text, /Never estimate/);
  });
  await withGemini({ items: [], activities: [{ kind: 'sleep' }], unclear: [], secret: 'drop' }, async () => { const j = await (await worker.fetch(wreq({ mode: 'catchup', text: 'ישנתי 7 שעות' }), env)).json(); assert.deepEqual(Object.keys(j).sort(), ['activities', 'items', 'unclear']); });
});
test('worker: rejects bad label input', async () => {
  for (const b of [{ mode: 'label' }, { mode: 'label', image: 'QUJD', mime: 'text/html' }, { mode: 'label', image: '<script>', mime: 'image/png' }, { mode: 'label', image: 'A'.repeat(3_000_001), mime: 'image/png' }, { mode: 'catchup', text: '  ' }]) assert.equal((await worker.fetch(wreq(b), env)).status, 400, JSON.stringify(b).slice(0, 40));
});
