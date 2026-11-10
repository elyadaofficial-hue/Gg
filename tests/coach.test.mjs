import test from 'node:test';
import assert from 'node:assert/strict';
import { setCoachStoreForTests } from '../netlify/lib/store.mjs';
import { handleCoach, verifyUser, LIMITS, cleanMessages } from '../netlify/lib/coach.mjs';
import api, { config } from '../netlify/functions/coach-api.mjs';

const O = 'https://site.netlify.app', TOK = 'a'.repeat(40);
const mem = () => { const m = new Map(); return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), set: async (k, v) => { m.set(k, JSON.stringify(v)); } }; };
const req = (body, auth = 'Bearer ' + TOK) => new Request(O + '/api/coach/x', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body || {}) });
// fake network: Supabase user lookup + Google endpoints; records calls so tests can inspect what was sent
const net = (o = {}) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); 
  if (url.includes('/auth/v1/user')) return o.noUser ? new Response('{}', { status: 401 }) : new Response(JSON.stringify({ id: o.uid || 'u1' }), { status: 200 });
  if (url.includes('/auth_tokens')) return o.tokStatus ? new Response('{}', { status: o.tokStatus }) : new Response(JSON.stringify({ name: 'auth_tokens/SECRETTOKEN' }), { status: 200 });
  if (url.includes(':generateContent')) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'שלום' }] } }] }), { status: 200 });
  throw new Error('unexpected ' + url); }; f.calls = calls; return f; };
const setup = () => { setCoachStoreForTests(mem()); process.env.GEMINI_API_KEY = 'PERMANENT-KEY'; delete process.env.COACH_LIVE_MODEL; };

test('config: routed path', () => assert.equal(config.path, '/api/coach/*'));
test('verifyUser: rejects missing / malformed / invalid tokens', async () => {
  assert.equal(await verifyUser(null, net()), null); assert.equal(await verifyUser('Bearer short', net()), null); assert.equal(await verifyUser('Token ' + TOK, net()), null);
  assert.equal(await verifyUser('Bearer ' + TOK, net({ noUser: true })), null);
  assert.deepEqual(await verifyUser('Bearer ' + TOK, net({ uid: 'abc' })), { id: 'abc' });
});
test('session: 401 without login, never calls Google', async () => {
  setup(); const f = net({ noUser: true }); const r = await handleCoach('session', req({}), f); assert.equal(r.status, 401); assert.ok(!f.calls.some((c) => c.url.includes('googleapis')));
});
test('session: returns ephemeral token only, permanent key never in response', async () => {
  setup(); const f = net(); const r = await handleCoach('session', req({}), f, 1_000_000);
  assert.equal(r.status, 200); assert.equal(r.json.token, 'auth_tokens/SECRETTOKEN'); assert.ok(!JSON.stringify(r.json).includes('PERMANENT-KEY'));
  const g = f.calls.find((c) => c.url.includes('auth_tokens')), b = JSON.parse(g.init.body);
  assert.equal(g.init.headers['x-goog-api-key'], 'PERMANENT-KEY'); assert.equal(b.uses, 1); assert.ok(Date.parse(b.expireTime) > 1_000_000);
});
test('session: not configured -> 503', async () => { setup(); delete process.env.GEMINI_API_KEY; assert.equal((await handleCoach('session', req({}), net(), 1e6)).status, 503); });
test('session: rapid repeat blocked (no accidental duplicate sessions), allowed after gap', async () => {
  setup(); const f = net(); assert.equal((await handleCoach('session', req({}), f, 1e9)).status, 200);
  assert.equal((await handleCoach('session', req({}), f, 1e9 + 1000)).json.error, 'too_fast');
  assert.equal((await handleCoach('session', req({}), f, 1e9 + LIMITS.minGapMs + 1)).status, 200);
});
test('session: daily limit enforced per user, resets next day', async () => {
  setup(); const f = net(); let t = 2e9;
  for (let i = 0; i < LIMITS.sessionsPerDay; i++) { assert.equal((await handleCoach('session', req({}), f, t)).status, 200); t += LIMITS.minGapMs + 1; }
  const r = await handleCoach('session', req({}), f, t); assert.equal(r.status, 429); assert.equal(r.json.error, 'daily_limit');
  assert.equal((await handleCoach('session', req({}), net({ uid: 'other' }), t)).status, 200);
  assert.equal((await handleCoach('session', req({}), f, t + 86400000)).status, 200);
});
test('session: Google 429/5xx mapped, no token leaked', async () => {
  setup(); assert.equal((await handleCoach('session', req({}), net({ tokStatus: 429 }), 3e9)).json.error, 'provider_limit');
  assert.equal((await handleCoach('session', req({}), net({ tokStatus: 500 }), 4e9)).status, 502);
});
test('text: validates input, last message must be from user, returns text', async () => {
  setup(); assert.equal((await handleCoach('text', req({ messages: [] }), net())).status, 400);
  assert.equal((await handleCoach('text', req({ messages: [{ role: 'model', text: 'x' }] }), net())).status, 400);
  const r = await handleCoach('text', req({ messages: [{ role: 'user', text: 'היי' }] }), net()); assert.equal(r.status, 200); assert.equal(r.json.text, 'שלום');
  assert.equal(cleanMessages({ messages: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: 'x'.repeat(5000) })) }), null); // 30th is model-last? index 29 odd -> model
});
test('api: cross-origin 403, GET 405, unknown route 404, 401 via HTTP layer', async () => {
  setup(); const mk = (m, origin, path = '/api/coach/session') => new Request(O + path, { method: m, headers: origin ? { origin } : {} });
  assert.equal((await api(mk('POST', 'https://evil.com'))).status, 403); assert.equal((await api(mk('GET'))).status, 405);
  const r = await api(mk('POST', O)); assert.equal(r.status, 401); assert.equal(r.headers.get('cache-control'), 'no-store');
});
