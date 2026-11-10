// Pure scheduling logic for Evening Reset reminders (no I/O, fully unit-tested).
export const GRACE_MS = 15 * 60 * 1000; // a missed tick can still fire up to 15 min late; never hours late

export function validTz(tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }

export function localParts(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}
// Instant (ms) at which wall-clock `date` + `HH:MM` occurs in tz (DST-safe, two passes).
export function instantFor(date, hhmm, tz) {
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const l = localParts(guess, tz);
    guess += wall - Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi);
  }
  return guess;
}
export const MAX_REMINDERS = 12;
// Custom daily reminders: [{ id, time:'HH:MM', message, days:[0..6] }]. days empty = every day (0 = Sunday, like the app's א..ש chips).
export function cleanReminders(list) {
  const out = [], seen = new Set();
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r !== 'object' || out.length >= MAX_REMINDERS) continue;
    const id = String(r.id == null ? '' : r.id).replace(/[^\w-]/g, '').slice(0, 40);
    if (!id || seen.has(id) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time)) continue;
    seen.add(id);
    const days = [...new Set((Array.isArray(r.days) ? r.days : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
    out.push({ id, time: r.time, message: typeof r.message === 'string' ? r.message.trim().slice(0, 120) : '', days: days.length === 7 ? [] : days });
  }
  return out;
}
export function cleanSettings(s) {
  s = s && typeof s === 'object' ? s : {};
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time) ? s.time : '22:30';
  const tz = typeof s.tz === 'string' && validTz(s.tz) ? s.tz : 'UTC';
  const rm = Math.round(Number(s.repeatMin));
  const quietDays = [...new Set((Array.isArray(s.quietDays) ? s.quietDays : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  return { enabled: !!s.enabled, time, tz, repeat: s.repeat !== false, repeatMin: rm >= 5 && rm <= 120 ? rm : 20, quietDays, reminders: cleanReminders(s.reminders) };
}
// Returns 'first' | 'repeat' | null
export function decide(sub, now) {
  const s = sub.settings; if (!s || !s.enabled) return null;
  const st = sub.state || {};
  const today = localParts(now, s.tz).date;
  if (st.skipDate === today) return null;
  // quiet nights: weekday 0=Sunday..6=Saturday in the user's timezone (matches the app's א..ש chips)
  const q = Array.isArray(s.quietDays) ? s.quietDays : [];
  const [qy, qm, qd] = today.split('-').map(Number), quiet = q.includes(new Date(Date.UTC(qy, qm - 1, qd)).getUTCDay());
  const sched = instantFor(today, s.time, s.tz);
  if (!quiet && st.lastNight !== today && now >= sched && now - sched <= GRACE_MS) return 'first';
  if (s.repeat && st.firstAt && !st.repeatAt) {
    const at = st.firstAt + s.repeatMin * 60000;
    const cancelled = st.cancelledAt && st.cancelledAt >= st.firstAt;
    if (!cancelled && now >= at && now - at <= GRACE_MS) return 'repeat';
  }
  return null;
}
export function afterSend(st, kind, now, tz) {
  st = { ...(st || {}) };
  if (kind === 'first') return { ...st, lastNight: localParts(now, tz).date, firstAt: now, repeatAt: null, cancelledAt: null };
  return { ...st, repeatAt: now };
}
// When settings change: allow a fresh send tonight if the new time is still ahead.
export function onSettingsChange(oldSub, newSettings, now) {
  const st = { ...((oldSub && oldSub.state) || {}) };
  const old = oldSub && oldSub.settings;
  if (old && (old.time !== newSettings.time || old.tz !== newSettings.tz)) {
    const today = localParts(now, newSettings.tz).date;
    if (instantFor(today, newSettings.time, newSettings.tz) > now) { st.lastNight = null; st.firstAt = null; st.repeatAt = null; }
  }
  if (!newSettings.enabled) { st.firstAt = null; st.repeatAt = null; }
  return reminderStateOnChange(oldSub, newSettings, now, st);
}

const dow = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
// Returns the custom reminders that are due right now (each fires once per local day, within the same 15 min grace window).
export function decideReminders(sub, now) {
  const s = sub && sub.settings; if (!s || !Array.isArray(s.reminders) || !s.reminders.length) return [];
  const st = (sub.state && sub.state.rem) || {}, today = localParts(now, s.tz).date, wd = dow(today), due = [];
  for (const r of s.reminders) {
    if (r.days && r.days.length && !r.days.includes(wd)) continue;
    if (st[r.id] === today) continue;
    const at = instantFor(today, r.time, s.tz);
    if (now >= at && now - at <= GRACE_MS) due.push(r);
  }
  return due;
}
export function afterReminders(st, ids, now, tz) {
  const date = localParts(now, tz).date, rem = { ...((st && st.rem) || {}) };
  for (const id of ids) rem[id] = date;
  return { ...(st || {}), rem };
}
// Keep reminder state tidy and avoid surprise late sends: a new/changed reminder whose time already passed today is treated as "done today".
export function reminderStateOnChange(oldSub, newSettings, now, state) {
  const oldMap = new Map(((oldSub && oldSub.settings && oldSub.settings.reminders) || []).map((r) => [r.id, r]));
  const today = localParts(now, newSettings.tz).date, rem = {};
  for (const r of newSettings.reminders || []) {
    const o = oldMap.get(r.id), prev = state.rem && state.rem[r.id];
    if (o && o.time === r.time && (!oldSub || oldSub.settings.tz === newSettings.tz)) { if (prev) rem[r.id] = prev; continue; }
    if (instantFor(today, r.time, newSettings.tz) <= now) rem[r.id] = today;
  }
  return { ...state, rem };
}
