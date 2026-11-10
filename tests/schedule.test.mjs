import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decide, afterSend, instantFor, localParts, onSettingsChange, cleanSettings, GRACE_MS } from '../netlify/lib/schedule.mjs';
import { setStoreForTests, memoryStore } from '../netlify/lib/store.mjs';
import { tick, upsertSubscription, markAction, subKey } from '../netlify/lib/core.mjs';
import { b64u } from '../netlify/lib/webpush.mjs';

const TZ = 'Asia/Jerusalem'; const at = (d, hm) => instantFor(d, hm, TZ); const MIN = 60000;
const mk = (o = {}) => ({ settings: cleanSettings({ enabled: true, time: '22:30', tz: TZ, repeat: true, repeatMin: 20, ...o }), state: {} });

test('instantFor/localParts round trip incl. DST change day (Israel 2026-03-27 spring forward)', () => {
  for (const d of ['2026-11-05', '2026-03-27', '2026-10-25']) { const t = at(d, '22:30'); const l = localParts(t, TZ); assert.equal(l.date, d); assert.equal(l.h * 60 + l.mi, 22 * 60 + 30); }
});
test('fires once at the time, not before, not hours late', () => {
  const s = mk(), t = at('2026-11-05', '22:30');
  assert.equal(decide(s, t - MIN), null);
  assert.equal(decide(s, t), 'first');
  assert.equal(decide(s, t + GRACE_MS), 'first');
  assert.equal(decide(s, t + GRACE_MS + MIN), null);
});
test('one repeat only, after the interval, then nothing', () => {
  const s = mk(), t = at('2026-11-05', '22:30');
  s.state = afterSend(s.state, 'first', t, TZ);
  assert.equal(decide(s, t + 19 * MIN), null);
  assert.equal(decide(s, t + 20 * MIN), 'repeat');
  s.state = afterSend(s.state, 'repeat', t + 20 * MIN, TZ);
  for (let m = 21; m < 600; m += 7) assert.equal(decide(s, t + m * MIN), null);
});
test('first sent only once per night even if ticks repeat', () => {
  const s = mk(), t = at('2026-11-05', '22:30');
  s.state = afterSend(s.state, 'first', t, TZ); assert.equal(decide({ ...s, settings: { ...s.settings, repeat: false } }, t + 5 * MIN), null);
});
test('cancel after first suppresses repeat; cancel before first does not', () => {
  const t = at('2026-11-05', '22:30'), s = mk();
  s.state = { ...afterSend({}, 'first', t, TZ), cancelledAt: t + 2 * MIN }; assert.equal(decide(s, t + 20 * MIN), null);
  s.state = { ...afterSend({ cancelledAt: t - 30 * MIN }, 'first', t, TZ), cancelledAt: null }; assert.equal(decide(s, t + 20 * MIN), 'repeat');
});
test('repeat can cross midnight; next night fires again', () => {
  const s = mk({ time: '23:50' }), t = at('2026-11-05', '23:50');
  s.state = afterSend({}, 'first', t, TZ); assert.equal(decide(s, t + 20 * MIN), 'repeat');
  s.state = afterSend(s.state, 'repeat', t + 20 * MIN, TZ);
  assert.equal(decide(s, at('2026-11-06', '23:50')), 'first');
});
test('disabled, skipped, and repeat-off', () => {
  const t = at('2026-11-05', '22:30');
  assert.equal(decide(mk({ enabled: false }), t), null);
  const sk = mk(); sk.state = { skipDate: '2026-11-05' }; assert.equal(decide(sk, t), null);
  const nr = mk({ repeat: false }); nr.state = afterSend({}, 'first', t, TZ); assert.equal(decide(nr, t + 20 * MIN), null);
});
test('changing time to a later time tonight allows a new send; earlier-than-now does not', () => {
  const t = at('2026-11-05', '22:30'), old = mk(); old.state = afterSend({}, 'first', t, TZ);
  const later = cleanSettings({ ...old.settings, time: '23:30' });
  assert.equal(decide({ settings: later, state: onSettingsChange(old, later, t + 10 * MIN) }, at('2026-11-05', '23:30')), 'first');
  const earlier = cleanSettings({ ...old.settings, time: '22:00' });
  assert.equal(decide({ settings: earlier, state: onSettingsChange(old, earlier, t + 10 * MIN) }, t + 10 * MIN), null);
});
test('cleanSettings rejects garbage', () => {
  const c = cleanSettings({ enabled: 1, time: '25:99', tz: 'Mars/Base', repeatMin: 9999 });
  assert.deepEqual(c, { enabled: true, time: '22:30', tz: 'UTC', repeat: true, repeatMin: 20, quietDays: [], reminders: [] });
});

test('tick end-to-end with fake push service', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = privateKey.export({ format: 'jwk' });
  process.env.VAPID_PUBLIC_KEY = b64u.enc(Buffer.concat([Buffer.from([4]), b64u.dec(jwk.x), b64u.dec(jwk.y)])); process.env.VAPID_PRIVATE_KEY = jwk.d;
  setStoreForTests(memoryStore());
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/test1', dead = 'https://fcm.googleapis.com/fcm/send/dead';
  const subscription = (e) => ({ endpoint: e, keys: { p256dh: b64u.enc(ua.getPublicKey()), auth: b64u.enc(crypto.randomBytes(16)) } });
  const t0 = at('2026-11-05', '22:30');
  assert.equal((await upsertSubscription({ subscription: subscription('https://evil.com/x'), settings: {} }, t0 - 9e6)).status, 400);
  await upsertSubscription({ subscription: subscription(endpoint), settings: { enabled: true, time: '22:30', tz: TZ, repeat: true, repeatMin: 20 } }, t0 - 9e6);
  await upsertSubscription({ subscription: subscription(dead), settings: { enabled: true, time: '22:30', tz: TZ } }, t0 - 9e6);
  const calls = []; const fetchImpl = async (u, o) => { calls.push({ u, topic: o.headers.Topic }); return { status: u === dead ? 410 : 201 }; };
  assert.deepEqual(await tick(t0 - MIN, fetchImpl), { checked: 2, sent: 0, failed: 0, removed: 0 });
  assert.deepEqual(await tick(t0, fetchImpl), { checked: 2, sent: 1, failed: 0, removed: 1 });
  assert.equal((await tick(t0 + MIN, fetchImpl)).sent, 0);                       // no duplicate
  await markAction(endpoint, 'cancel', t0 + 5 * MIN);
  assert.equal((await tick(t0 + 20 * MIN, fetchImpl)).sent, 0);                  // repeat cancelled
  assert.equal(calls.length, 2);
  // second night: not cancelled -> exactly one first + one repeat
  const t1 = at('2026-11-06', '22:30'); calls.length = 0;
  await tick(t1, fetchImpl); await tick(t1 + 20 * MIN, fetchImpl); await tick(t1 + 40 * MIN, fetchImpl); await tick(t1 + 60 * MIN, fetchImpl);
  assert.equal(calls.length, 2);
  // transient failure reverts state, then retries within grace
  const t2 = at('2026-11-07', '22:30'); let fail = true; const flaky = async () => ({ status: fail ? 503 : 201 });
  assert.equal((await tick(t2, flaky)).failed, 1); fail = false; assert.equal((await tick(t2 + MIN, flaky)).sent, 1);
});

test('quiet nights: no first reminder on a quiet weekday, normal on others; cleanSettings sanitises', () => {
  // 2026-11-05 is Thursday (4), 2026-11-06 is Friday (5)
  const s = mk({ quietDays: [5, 5, 9, 'x', -1] });
  assert.deepEqual(s.settings.quietDays, [5]);
  assert.equal(decide(s, at('2026-11-06', '22:30')), null);
  assert.equal(decide(s, at('2026-11-05', '22:30')), 'first');
  assert.deepEqual(cleanSettings({}).quietDays, []);
});

// ---- custom reminders (v10.7): real push notifications for the home-page reminders ----
import { cleanReminders, decideReminders, afterReminders } from '../netlify/lib/schedule.mjs';
import { reminderPayload, COACH } from '../netlify/lib/core.mjs';
const mkR = (reminders, o = {}) => ({ settings: cleanSettings({ enabled: false, tz: TZ, reminders, ...o }), state: {} });

test('cleanReminders: validates, caps, dedupes, all-7-days means every day', () => {
  const c = cleanReminders([{ id: 'a', time: '20:00', message: '  hi ', days: [1, 1, 9, 'x', 3] }, { id: 'a', time: '21:00' }, { id: 'b', time: '25:00' }, { id: 'c b!', time: '07:05', days: [0, 1, 2, 3, 4, 5, 6] }, null, 5]);
  assert.deepEqual(c, [{ id: 'a', time: '20:00', message: 'hi', days: [1, 3] }, { id: 'cb', time: '07:05', message: '', days: [] }]);
  assert.equal(cleanReminders(Array.from({ length: 30 }, (_, i) => ({ id: 'r' + i, time: '08:00' }))).length, 12);
  assert.deepEqual(cleanReminders('nope'), []);
});
test('reminders fire once per day at their time, within grace, only on chosen weekdays, even with Evening Reset off', () => {
  // 2026-11-05 Thursday (4), 2026-11-06 Friday (5)
  const s = mkR([{ id: 'r1', time: '20:00', message: 'x', days: [4] }, { id: 'r2', time: '20:00', message: '', days: [] }]);
  const t = at('2026-11-05', '20:00');
  assert.equal(decideReminders(s, t - MIN).length, 0);
  assert.deepEqual(decideReminders(s, t).map((r) => r.id), ['r1', 'r2']);
  assert.equal(decideReminders(s, t + GRACE_MS + MIN).length, 0);                     // never hours late
  s.state = afterReminders(s.state, ['r1', 'r2'], t, TZ);
  assert.equal(decideReminders(s, t + 2 * MIN).length, 0);                            // once per day
  const f = at('2026-11-06', '20:00');
  assert.deepEqual(decideReminders(s, f).map((r) => r.id), ['r2']);                   // r1 is Thursday only
  assert.equal(decide(s, at('2026-11-05', '22:30')), null);                           // Evening Reset still off
});
test('new or changed reminder never fires "late" for a time that already passed today; a later time still fires', async () => {
  setStoreForTests(memoryStore());
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/remtest';
  const sub = { endpoint, keys: { p256dh: b64u.enc(ua.getPublicKey()), auth: b64u.enc(crypto.randomBytes(16)) } };
  const now = at('2026-11-05', '20:10');
  await upsertSubscription({ subscription: sub, settings: { tz: TZ, reminders: [{ id: 'p', time: '20:00' }, { id: 'f', time: '20:30' }] } }, now);
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = privateKey.export({ format: 'jwk' });
  process.env.VAPID_PUBLIC_KEY = b64u.enc(Buffer.concat([Buffer.from([4]), b64u.dec(jwk.x), b64u.dec(jwk.y)])); process.env.VAPID_PRIVATE_KEY = jwk.d;
  const bodies = []; const fetchImpl = async (u, o) => { bodies.push(o); return { status: 201 }; };
  assert.equal((await tick(now + MIN, fetchImpl)).sent, 0);                          // 'p' passed 10 min ago: skipped, not sent late
  assert.equal((await tick(at('2026-11-05', '20:30'), fetchImpl)).sent, 1);          // 'f' fires on time
  assert.equal((await tick(at('2026-11-05', '20:31'), fetchImpl)).sent, 0);          // and only once
  assert.equal((await tick(at('2026-11-06', '20:00'), fetchImpl)).sent, 1);          // 'p' fires the next day
  // transient failure on a reminder retries within grace, without double sending
  let fail = true; const flaky = async () => ({ status: fail ? 503 : 201 });
  assert.equal((await tick(at('2026-11-07', '20:00'), flaky)).failed, 1); fail = false;
  assert.equal((await tick(at('2026-11-07', '20:01'), flaky)).sent, 1);
  assert.equal((await tick(at('2026-11-07', '20:02'), flaky)).sent, 0);
});
test('reminder payload: own message, or a coach line; distinct tag per reminder; opens the app, not the reset', () => {
  const a = reminderPayload({ id: 'r1', message: 'שתה מים' }, '2026-11-05'), b = reminderPayload({ id: 'r2', message: '' }, '2026-11-05');
  assert.equal(a.body, 'שתה מים'); assert.ok(COACH.includes(b.body)); assert.notEqual(a.tag, b.tag);
  assert.equal(a.kind, 'reminder'); assert.ok(!a.url.includes('reset=1'));
});
