import crypto from 'node:crypto';
import { sendPush, isAllowedEndpoint } from './webpush.mjs';
import { decide, afterSend, cleanSettings, onSettingsChange, localParts, decideReminders, afterReminders } from './schedule.mjs';
import { getSubStore } from './store.mjs';

export const env = (k) => (typeof Netlify !== 'undefined' && Netlify.env ? Netlify.env.get(k) : process.env[k]);
export const MAX_SUBS = 25;
export const subKey = (endpoint) => 'sub:' + crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 40);
export function vapid() {
  const publicKey = env('VAPID_PUBLIC_KEY'), privateKey = env('VAPID_PRIVATE_KEY');
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: env('VAPID_SUBJECT') || 'mailto:admin@example.com' };
}
// Friendly, guilt-free copy. kind: first | repeat | test
export const MESSAGES = {
  first: { title: 'Evening Reset 🌙', body: 'עדיין גולל? בוא נעשה את הערב קל יותר.' },
  repeat: { title: 'Evening Reset 🌙', body: 'תזכורת עדינה: דקה אחת שתעזור לערב להיות רגוע יותר.' },
  test: { title: 'Evening Reset 🌙', body: 'בדיקה: ככה ייראו התזכורות שלך.' },
};
// Used when a custom reminder has no message of its own (same spirit as the app's coach lines).
export const COACH = ['אתה בדרך הנכונה. תמשיך ⚡', 'אל תשכח למה התחלת 💪', 'עוד צעד קטן היום', 'אתה חזק יותר משאתה חושב', 'היום הוא הזדמנות להתקדם', 'אל תוותר עכשיו, אתה כל כך קרוב', 'תזכורת: אתה מסוגל לזה', 'משמעת היום = חופש מחר', 'קדימה, רק את זה ואז אפשר לנוח', 'ההתמדה שלך היא הסיפור שתספר בעתיד'];
export function reminderPayload(r, date) {
  let h = 0; for (const ch of r.id + date) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { title: '🔔 תזכורת', body: r.message || COACH[h % COACH.length], kind: 'reminder', url: './index.html?src=reminder', tag: 'rem-' + r.id };
}
export const payloadFor = (kind) => ({ ...MESSAGES[kind], kind, url: './index.html?reset=1&src=push', tag: 'evening-reset' });

export async function upsertSubscription(body, now = Date.now()) {
  const sub = body && body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !isAllowedEndpoint(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { status: 400, json: { error: 'bad subscription' } };
  const store = await getSubStore(), key = subKey(sub.endpoint), old = await store.get(key);
  if (!old && (await store.list()).length >= MAX_SUBS) return { status: 429, json: { error: 'too many subscriptions' } };
  const settings = cleanSettings(body.settings);
  const rec = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, settings, state: onSettingsChange(old, settings, now), createdAt: (old && old.createdAt) || now, updatedAt: now };
  await store.set(key, rec);
  return { status: 200, json: { ok: true, settings, today: localParts(now, settings.tz).date } };
}
export async function removeSubscription(endpoint) {
  if (typeof endpoint !== 'string') return { status: 400, json: { error: 'endpoint required' } };
  await (await getSubStore()).del(subKey(endpoint)); return { status: 200, json: { ok: true } };
}
// action: 'cancel' (user opened the reset / tapped the notification) | 'skip' (skip tonight's reminders)
export async function markAction(endpoint, action, now = Date.now()) {
  if (typeof endpoint !== 'string') return { status: 400, json: { error: 'endpoint required' } };
  const store = await getSubStore(), key = subKey(endpoint), rec = await store.get(key);
  if (!rec) return { status: 404, json: { error: 'unknown subscription' } };
  rec.state = rec.state || {};
  if (action === 'skip') rec.state.skipDate = localParts(now, rec.settings.tz).date; else if (action === 'unskip') rec.state.skipDate = null; else rec.state.cancelledAt = now;
  await store.set(key, rec); return { status: 200, json: { ok: true } };
}
export async function sendTest(endpoint, fetchImpl) {
  const v = vapid(); if (!v) return { status: 503, json: { error: 'VAPID keys not configured' } };
  const rec = await (await getSubStore()).get(subKey(String(endpoint || '')));
  if (!rec) return { status: 404, json: { error: 'unknown subscription' } };
  const r = await sendPush(rec, payloadFor('test'), v, { fetchImpl, ttl: 120, topic: 'er-test' });
  if (r.gone) await (await getSubStore()).del(subKey(rec.endpoint));
  return { status: r.ok ? 200 : 502, json: { ok: r.ok, status: r.status, gone: r.gone } };
}
// One scheduler pass. Marks state BEFORE sending (no double-send if ticks overlap), reverts on transient failure.
export async function tick(now = Date.now(), fetchImpl) {
  const v = vapid(); if (!v) return { skipped: 'no-vapid' };
  const store = await getSubStore(), out = { checked: 0, sent: 0, failed: 0, removed: 0 };
  for (const key of await store.list()) {
    const rec = await store.get(key); if (!rec) continue; out.checked++;
    const kind = decide(rec, now), due = decideReminders(rec, now); if (!kind && !due.length) continue;
    const prev = rec.state; let st = prev;
    if (kind) st = afterSend(st, kind, now, rec.settings.tz);
    if (due.length) st = afterReminders(st, due.map((r) => r.id), now, rec.settings.tz);
    rec.state = st; await store.set(key, rec);
    const jobs = []; if (kind) jobs.push({ kind, payload: payloadFor(kind) });
    const date = localParts(now, rec.settings.tz).date; for (const r of due) jobs.push({ kind: 'reminder', id: r.id, payload: reminderPayload(r, date) });
    let gone = false, failedAny = false; const retry = { ...prev };
    for (const j of jobs) {
      let r; try { r = await sendPush(rec, j.payload, v, { fetchImpl }); } catch (e) { r = { ok: false, status: 0, gone: false, error: String(e && e.message) }; }
      if (r.ok) { out.sent++; continue; }
      if (r.gone) { gone = true; break; }
      failedAny = true; out.failed++;
      // transient failure: un-mark only what failed so the next tick (within the grace window) retries it
      if (j.kind === 'reminder') { const rem = { ...(rec.state.rem || {}) }; if (prev && prev.rem && prev.rem[j.id]) rem[j.id] = prev.rem[j.id]; else delete rem[j.id]; rec.state = { ...rec.state, rem, lastError: `${r.status || r.error} @${now}` }; }
      else rec.state = { ...prev, rem: rec.state.rem, lastError: `${r.status || r.error} @${now}` };
    }
    if (gone) { await store.del(key); out.removed++; continue; }
    if (failedAny) await store.set(key, rec);
  }
  return out;
}
