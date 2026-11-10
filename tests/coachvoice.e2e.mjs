// Browser test of the Coach UI/state machine with a fake Gemini Live socket and a synthetic microphone.
// Run: python3 -m http.server 8765 & node tests/coachvoice.e2e.mjs   (needs Playwright + Chromium)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
let fails = 0; const ck = (n, c) => { console.log(c ? 'PASS' : 'FAIL', n); if (!c) fails++; };
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
await pg.addInitScript(() => {
  localStorage.setItem('wisey-login-asked', 'true');
  window.__sent = []; window.__sockets = []; window.__mic = { denied: false };
  navigator.mediaDevices.getUserMedia = async () => { if (window.__mic.denied) { const e = new Error('no'); e.name = 'NotAllowedError'; throw e; }
    const ac = new AudioContext(), o = ac.createOscillator(), d = ac.createMediaStreamDestination(); o.frequency.value = 300; o.connect(d); o.start(); return d.stream; };
  window.WebSocket = class { constructor(url) { this.url = url; this.readyState = 0; window.__sockets.push(this);
    setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 10); }
    send(s) { const m = JSON.parse(s); window.__sent.push(m); if (m.setup) setTimeout(() => this.emit({ setupComplete: {} }), 10); }
    emit(o) { this.onmessage && this.onmessage({ data: JSON.stringify(o) }); }
    close(c) { this.readyState = 3; this.onclose && this.onclose({ code: c || 1000 }); } };
});
await pg.goto('http://localhost:8765/index.html'); await pg.waitForTimeout(800);
const login = () => pg.evaluate(() => { ws.sess = { access_token: 'x'.repeat(40), refresh_token: 'r', expires_at: Date.now() / 1000 + 3600, user: { id: 'u', email: 'a@b.c' } }; });
const mockApi = (handler) => pg.route('**/api/coach/**', handler);
const ok = (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'auth_tokens/T', model: 'm-live', used: 1, limit: 12 }) });
const state = () => pg.evaluate(() => __coach.state);
const openPanel = async () => { if ((await pg.getAttribute('#cv-root', 'data-open')) !== '1') { await pg.click('#cv-handle'); await pg.waitForTimeout(450); } };
await pg.waitForTimeout(200);
ck('edge handle present on Home tab', await pg.locator('#cv-handle').isVisible());
for (const tab of ['workout', 'nutrition', 'prayer', 'coach']) { await pg.evaluate(`goTo('${tab}')`); await pg.waitForTimeout(150); if (!(await pg.locator('#cv-handle').isVisible())) ck('handle on ' + tab, false); }
ck('edge handle visible on every tab checked', true);
ck('Coach tab has open-coach card', (await pg.locator('button:has-text("פתח את המאמן")').count()) === 1);
ck('handle does not overlap other fixed controls', await pg.evaluate(() => { const h = document.getElementById('cv-handle').getBoundingClientRect(); return [...document.querySelectorAll('body *')].filter((e) => e.id !== 'cv-handle' && !e.closest('#cv-root') && getComputedStyle(e).position === 'fixed' && e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width < 200).every((e) => { const r = e.getBoundingClientRect(); return r.right <= h.left || r.left >= h.right || r.bottom <= h.top || r.top >= h.bottom; }); }));
await openPanel();
ck('panel opens with start button and pinned typing box', (await pg.locator('button:has-text("דבר עם המאמן")').count()) === 1 && await pg.locator('#cv-in').isVisible() && await pg.evaluate(() => { const r = document.getElementById('cv-in').getBoundingClientRect(); return r.bottom <= innerHeight && r.height >= 44 && r.width > 150; }));
ck('typed Hebrew keeps order and input is RTL', await (async () => { await pg.fill('#cv-in', 'שלום מאמן'); const v = await pg.inputValue('#cv-in'); const d = await pg.evaluate(() => getComputedStyle(document.getElementById('cv-in')).direction); await pg.fill('#cv-in', ''); return v === 'שלום מאמן' && d === 'rtl'; })());
ck('idle state initially', (await state()) === 'idle');
// not logged in
await pg.click('button:has-text("דבר עם המאמן")'); await pg.waitForTimeout(200);
ck('requires login -> error state with message', (await state()) === 'error' && (await pg.innerText('#cv-msg')).includes('להתחבר'));
await login();
// permission denied
await pg.evaluate(() => (__mic.denied = true)); await mockApi(ok);
await pg.click('button:has-text("נסה שוב")'); await pg.waitForTimeout(300);
ck('mic denied -> error + helpful message', (await state()) === 'error' && (await pg.innerText('#cv-msg')).includes('מיקרופון'));
await pg.evaluate(() => (__mic.denied = false));
// happy path
let calls = 0; await pg.unroute('**/api/coach/**'); await mockApi((r) => { calls++; return ok(r); });
await pg.click('button:has-text("נסה שוב")'); await pg.waitForTimeout(900);
ck('listening after connect', (await state()) === 'listening');
const url = await pg.evaluate(() => __sockets.at(-1).url);
ck('uses ephemeral token on constrained endpoint (no api key)', url.includes('BidiGenerateContentConstrained?access_token=auth_tokens%2FT') && !url.includes('key='));
const setup = await pg.evaluate(() => __sent.find((m) => m.setup).setup);
ck('setup: audio-only, Hebrew prompt, transcription on', setup.model === 'models/m-live' && setup.generationConfig.responseModalities[0] === 'AUDIO' && /עברית/.test(setup.systemInstruction.parts[0].text) && !!setup.inputAudioTranscription && !!setup.outputAudioTranscription);
await pg.waitForTimeout(600);
const audioMsgs = await pg.evaluate(() => __sent.filter((m) => m.realtimeInput && m.realtimeInput.audio));
ck('real mic audio streamed as 16 kHz PCM', audioMsgs.length > 3 && audioMsgs[0].realtimeInput.audio.mimeType === 'audio/pcm;rate=16000' && audioMsgs[0].realtimeInput.audio.data.length > 100);
ck('start while live does not create another session', await (async () => { await pg.evaluate('cvStart()'); await pg.waitForTimeout(200); return calls === 1; })());
// speaking + transcripts
await pg.evaluate(() => { const pcm = new Int16Array(24000); for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 8) * 8000; let s = ''; new Uint8Array(pcm.buffer).forEach((v) => (s += String.fromCharCode(v)));
  __sockets.at(-1).emit({ serverContent: { inputTranscription: { text: 'שלום מאמן' } } });
  __sockets.at(-1).emit({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: btoa(s) } }] }, outputTranscription: { text: 'היי, מה התוכנית להיום?' } } }); });
await pg.waitForTimeout(150);
ck('speaking state when audio arrives', (await state()) === 'speaking');
ck('Hebrew transcript shown RTL, both sides', (await pg.locator('.cv-b.user').innerText()).includes('שלום') && (await pg.locator('.cv-b.coach').innerText()).includes('תוכנית') && (await pg.getAttribute('#cv-panel', 'dir')) === 'rtl');
// interruption
await pg.evaluate(() => __sockets.at(-1).emit({ serverContent: { interrupted: true } })); await pg.waitForTimeout(100);
ck('interruption stops playback -> listening', (await state()) === 'listening' && (await pg.evaluate(() => __coach.sources.size)) === 0);
// mute
await pg.click('button:has-text("השתק")'); await pg.waitForTimeout(100);
ck('mute disables mic track', await pg.evaluate(() => __coach.muted && __coach.stream.getAudioTracks()[0].enabled === false));
const n1 = await pg.evaluate(() => __sent.filter((m) => m.realtimeInput && m.realtimeInput.audio).length); await pg.waitForTimeout(400);
ck('no audio sent while muted', (await pg.evaluate(() => __sent.filter((m) => m.realtimeInput && m.realtimeInput.audio).length)) === n1);
await pg.click('button:has-text("בטל השתקה")');
// drop -> reconnect with fresh token
await pg.evaluate(() => __sockets.at(-1).close(1006)); await pg.waitForTimeout(2600);
ck('unexpected drop -> auto reconnect with new token', (await state()) === "listening" && calls === 2);
// session expiry notice
await pg.evaluate(() => __sockets.at(-1).emit({ goAway: { timeLeft: '5s' } })); await pg.waitForTimeout(2600);
ck('goAway -> reconnect', (await state()) === "listening" && calls === 3);
// orb is alive: canvas has pixels and changes between frames; session survives closing panel / changing tabs
const snap = () => pg.evaluate(() => { const c = document.getElementById('cv-cv'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0, n = 0; for (let i = 0; i < d.length; i += 4 * 37) { s += d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3]; n += d[i + 3] > 10 ? 1 : 0; } return [s, n]; });
const f1 = await snap(); await pg.waitForTimeout(350); const f2 = await snap();
ck('orb canvas draws visible pixels', f1[1] > 50); ck('orb animates between frames', f1[0] !== f2[0]);
await pg.click('#cv-x'); await pg.waitForTimeout(450); await pg.evaluate("goTo('workout')"); await pg.waitForTimeout(300);
ck('session keeps running after closing panel and switching tab; handle shows live', (await state()) === 'listening' && (await pg.getAttribute('#cv-handle', 'data-live')) === '1' && (await pg.locator('#cv-handle').isVisible()));
await pg.click('#cv-handle'); await pg.waitForTimeout(450);
// disconnect
await pg.click('button:has-text("סיים")'); await pg.waitForTimeout(200);
ck('hang up -> idle, mic released, socket closed', (await state()) === 'idle' && (await pg.evaluate(() => __coach.stream === null && __sockets.at(-1).readyState === 3)));
// server-side errors
for (const [status, code, text] of [[401, 'login_required', 'התחבר'], [429, 'daily_limit', 'מגבלת'], [429, 'provider_limit', 'מכסת'], [503, 'not_configured', 'GEMINI_API_KEY'], [429, 'too_fast', 'רגע']]) {
  await pg.unroute('**/api/coach/**'); await mockApi((r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: code }) }));
  await pg.evaluate('cvStart()'); await pg.waitForTimeout(400);
  ck(`server ${status}/${code} -> error message`, (await state()) === 'error' && (await pg.innerText('#cv-msg')).includes(text)); await pg.evaluate('__coach.set("idle")');
}
// text fallback
await pg.unroute('**/api/coach/**'); let body; await mockApi((r) => { body = r.request().postDataJSON(); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'בוא נתחיל מצעד קטן.' }) }); });
await pg.fill('#cv-in', 'אני מרגיש מוצף'); await pg.click('#cv-send'); await pg.waitForTimeout(400);
ck('text fallback sends and shows reply', body.messages.at(-1).text === 'אני מרגיש מוצף' && (await pg.innerText('#cv-log')).includes('צעד קטן'));
// layout
ck('no horizontal overflow at 390px', await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
ck('buttons are thumb-sized (>=44px)', await pg.evaluate(() => [...document.querySelectorAll('#cv-panel button')].every((x) => x.getBoundingClientRect().height >= 44)));
await pg.emulateMedia({ reducedMotion: 'reduce' }); await pg.evaluate("__coach.set('thinking')");
const tdv = await pg.evaluate(() => getComputedStyle(document.getElementById('cv-panel')).transitionDuration); console.log('transitionDuration=', tdv); ck('reduced motion: panel has no slide transition', parseFloat(tdv) < 0.001);
ck('permanent key never in page source', !(await pg.content()).includes('GEMINI_API_KEY=') );
console.log('pageerrors', errs); if (errs.length) fails++;
await b.close(); process.exit(fails ? 1 : 0);
