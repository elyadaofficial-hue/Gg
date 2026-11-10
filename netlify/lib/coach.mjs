// AI Coach server logic: login check, usage limits, Gemini Live ephemeral token, text fallback.
// Provider-specific code lives in the two `gemini*` functions so another provider can replace them later.
import { env } from './core.mjs';
import { getCoachStore } from './store.mjs';

export const LIMITS = { sessionsPerDay: 12, minGapMs: 4000, textPerDay: 80, tokenTtlMs: 30 * 60 * 1000, newSessionWindowMs: 60 * 1000 };
const SUPABASE_URL = () => env('SUPABASE_URL') || 'https://qjwnmdsoyknxnxvidphq.supabase.co';
// The Supabase publishable key is public by design (it is also in index.html); it is not a secret.
const SUPABASE_KEY = () => env('SUPABASE_PUBLISHABLE_KEY') || 'sb_publishable_gce0sNb53rRQ5aFyp33nMw_yky1Lomd';
export const DEFAULT_LIVE_MODEL = 'gemini-live-2.5-flash-preview';

// Returns { id } for a valid Supabase session token, else null. Never trusts a client-sent user id.
export async function verifyUser(authHeader, fetchImpl = fetch) {
  const m = /^Bearer\s+([\w.-]{20,4000})$/.exec(authHeader || '');
  if (!m) return null;
  try {
    const r = await fetchImpl(SUPABASE_URL() + '/auth/v1/user', { headers: { apikey: SUPABASE_KEY(), Authorization: 'Bearer ' + m[1] } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && typeof u.id === 'string' ? { id: u.id } : null;
  } catch (e) { return null; }
}

const dayKey = (now) => new Date(now).toISOString().slice(0, 10);
// kind: 'session' | 'text'. Counts per user per UTC day and enforces a minimum gap (prevents accidental repeats).
export async function useQuota(uid, kind, now = Date.now()) {
  const store = await getCoachStore(), key = 'u:' + uid + ':' + dayKey(now);
  const rec = (await store.get(key)) || { session: 0, text: 0, last: 0 };
  const max = kind === 'session' ? LIMITS.sessionsPerDay : LIMITS.textPerDay;
  if (kind === 'session' && now - (rec.last || 0) < LIMITS.minGapMs) return { ok: false, status: 429, error: 'too_fast' };
  if ((rec[kind] || 0) >= max) return { ok: false, status: 429, error: 'daily_limit', limit: max };
  rec[kind] = (rec[kind] || 0) + 1; if (kind === 'session') rec.last = now;
  await store.set(key, rec);
  return { ok: true, used: rec[kind], limit: max };
}

// --- Gemini adapter ---------------------------------------------------------------------
// Creates a short-lived, single-use token. The permanent key is only sent to Google from here.
export async function geminiLiveToken(fetchImpl = fetch, now = Date.now()) {
  const key = env('GEMINI_API_KEY');
  if (!key) return { status: 503, json: { error: 'not_configured' } };
  const model = env('COACH_LIVE_MODEL') || DEFAULT_LIVE_MODEL;
  const body = { uses: 1, expireTime: new Date(now + LIMITS.tokenTtlMs).toISOString(), newSessionExpireTime: new Date(now + LIMITS.newSessionWindowMs).toISOString() };
  let r;
  try { r = await fetchImpl('https://generativelanguage.googleapis.com/v1alpha/auth_tokens', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) }); }
  catch (e) { return { status: 502, json: { error: 'upstream_unreachable' } }; }
  if (r.status === 429) return { status: 429, json: { error: 'provider_limit' } };
  if (!r.ok) return { status: 502, json: { error: 'upstream_error', code: r.status } };
  let d; try { d = await r.json(); } catch (e) { return { status: 502, json: { error: 'bad_upstream' } }; }
  if (!d || typeof d.name !== 'string' || d.name.indexOf('auth_tokens/') !== 0) return { status: 502, json: { error: 'bad_upstream' } };
  return { status: 200, json: { token: d.name, model, expiresAt: body.expireTime, newSessionBy: body.newSessionExpireTime } };
}

export const COACH_TEXT_SYSTEM = 'אתה מאמן אישי ישיר, כן, מעשי ותומך. ענה בעברית בקצרה (עד 4 משפטים), בלי נאומי מוטיבציה, בלי בושה או לחץ. אתה לא רופא ולא מטפל. אל תמציא נתונים על המשתמש שלא נמסרו לך.';
let discovered = null; // text model found via the models list, remembered while the function instance lives
// Finds a general text model this key can use (skips live/audio/image/etc.). Used only if the configured one is rejected.
export async function discoverTextModel(key, fetchImpl = fetch) {
  try {
    const r = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    if (!r.ok) return null;
    const names = ((await r.json()).models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /^models\/gemini-.*flash/.test(m.name) && !/live|tts|image|audio|robotics|embed|transcribe|translate|thinking|preview/.test(m.name)).map((m) => m.name.replace(/^models\//, ''));
    names.sort((x, y) => (/latest/.test(y) ? 1 : 0) - (/latest/.test(x) ? 1 : 0) || (x < y ? 1 : -1));
    return names[0] || null;
  } catch (e) { return null; }
}
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
// Google sometimes answers 500/503 ("overloaded"); retry briefly before giving up.
async function textCall(model, key, body, fetchImpl, sleep = SLEEP) {
  let r;
  for (let i = 0; i < 3; i++) {
    r = await rawText(model, key, body, fetchImpl);
    if (r.status !== 503 && r.status !== 500) return r;
    if (i < 2) await sleep(i === 0 ? 500 : 1200);
  }
  return r;
}
function rawText(model, key, body, fetchImpl) {
  return fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
}
export async function geminiText(messages, fetchImpl = fetch) {
  const key = env('GEMINI_API_KEY');
  if (!key) return { status: 503, json: { error: 'not_configured' } };
  const contents = messages.map((m) => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: String(m.text).slice(0, 2000) }] }));
  const body = { systemInstruction: { parts: [{ text: COACH_TEXT_SYSTEM }] }, contents, generationConfig: { temperature: 0.7, maxOutputTokens: 400 } };
  let model = discovered || env('GEMINI_MODEL') || 'gemini-flash-latest', r;
  try {
    r = await textCall(model, key, body, fetchImpl);
    if (r.status === 404 || r.status === 400 || r.status === 503 || r.status === 500) { // model name not valid for this key: look up one that is, once
      const alt = await discoverTextModel(key, fetchImpl);
      if (alt && alt !== model) { model = alt; r = await textCall(model, key, body, fetchImpl); if (r.ok) discovered = alt; }
    }
  } catch (e) { return { status: 502, json: { error: 'upstream_unreachable' } }; }
  if (r.status === 429) return { status: 429, json: { error: 'provider_limit' } };
  if (!r.ok) { let detail = ''; try { detail = String((await r.json()).error?.message || '').slice(0, 160); } catch (e) {} console.error('gemini text', r.status, detail); return { status: 502, json: { error: 'upstream_error', code: r.status, detail } }; }
  try { const d = await r.json(); const text = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim(); return text ? { status: 200, json: { text } } : { status: 502, json: { error: 'empty' } }; }
  catch (e) { return { status: 502, json: { error: 'bad_upstream' } }; }
}

export function cleanMessages(body) {
  const a = body && Array.isArray(body.messages) ? body.messages.slice(-12) : null;
  if (!a || !a.length) return null;
  const out = a.filter((m) => m && typeof m.text === 'string' && m.text.trim() && (m.role === 'user' || m.role === 'model')).map((m) => ({ role: m.role, text: m.text.trim().slice(0, 2000) }));
  return out.length && out[out.length - 1].role === 'user' ? out : null;
}

export async function handleCoach(route, req, fetchImpl = fetch, now = Date.now()) {
  const user = await verifyUser(req.headers.get('authorization'), fetchImpl);
  if (!user) return { status: 401, json: { error: 'login_required' } };
  if (route === 'session') {
    const q = await useQuota(user.id, 'session', now);
    if (!q.ok) return { status: q.status, json: { error: q.error, limit: q.limit } };
    const r = await geminiLiveToken(fetchImpl, now);
    return r.status === 200 ? { status: 200, json: { ...r.json, used: q.used, limit: q.limit } } : r;
  }
  if (route === 'text') {
    const body = await req.json().catch(() => null), msgs = cleanMessages(body);
    if (!msgs) return { status: 400, json: { error: 'bad_request' } };
    const q = await useQuota(user.id, 'text', now);
    if (!q.ok) return { status: q.status, json: { error: q.error, limit: q.limit } };
    return geminiText(msgs, fetchImpl);
  }
  return { status: 404, json: { error: 'not found' } };
}
