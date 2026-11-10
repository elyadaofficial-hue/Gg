/* AI Coach: real-time voice (Gemini Live over WebSocket) + text fallback.
   - The permanent API key never reaches this file: /api/coach/session returns a short-lived single-use token.
   - Provider code is isolated in `GeminiLive`; the UI talks only to the `Coach` controller.
   - Loaded after the main script; relies on globals: ws, wsToken, wsOpenSheet, toast, esc, render, active, renderCoach. */
(function () {
  'use strict';
  const API = '/api/coach/';
  const STATES = { idle: 'מוכן', connecting: 'מתחבר…', listening: 'מקשיב', thinking: 'חושב…', speaking: 'מדבר', error: 'שגיאה', disconnected: 'מנותק' };
  const COACH_PROMPT = [
    'אתה המאמן האישי של אלידע: מאמן אחריותיות וצמיחה. דבר עברית טבעית ויומיומית (אנגלית אם הוא עובר לאנגלית), בקול רגוע ושיחתי, לא כמו קורא טקסט או מערכת ניווט.',
    'אופי: ישיר, כן, חכם, מעשי, מעודד ואנליטי. תומך בלי להסכים עם הכול. אתגר החלטות חלשות, שאל שאלה חדה אחת בכל פעם, עזור לתעדף ולהציע צעד הבא ריאלי.',
    'ענה קצר (שניים-שלושה משפטים) אלא אם ביקשו הרחבה. בלי נאומי מוטיבציה: עידוד רק כשיש התקדמות אמיתית. לעולם לא בושה, האשמה, השפלה או לחץ לא ריאלי.',
    'כבד שינה, התאוששות ושגרה בריאה. אתה מאמן פרודוקטיביות ואחריותיות, לא רופא ולא מטפל.',
    'חשוב: כרגע אין לך גישה לנתוני הדשבורד של המשתמש. אל תמציא נתונים, סטטיסטיקות או היסטוריה. אם שואלים על נתונים שלו, אמור שעדיין אין לך גישה אליהם ושאל אותו.'
  ].join(' ');

  /* ---------------- Provider: Gemini Live (WebSocket, ephemeral token) ---------------- */
  class GeminiLive {
    constructor(h) { this.h = h; this.ws = null; this.ready = false; }
    open(token, model) {
      return new Promise((resolve, reject) => {
        const url = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=' + encodeURIComponent(token);
        let done = false; const ws = (this.ws = new WebSocket(url));
        const fail = (e) => { if (!done) { done = true; reject(e); } };
        const timer = setTimeout(() => { fail(new Error('timeout')); try { ws.close(); } catch (e) {} }, 15000);
        ws.onopen = () => ws.send(JSON.stringify({ setup: {
          model: 'models/' + model,
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } } },
          systemInstruction: { parts: [{ text: COACH_PROMPT }] },
          inputAudioTranscription: {}, outputAudioTranscription: {},
          realtimeInputConfig: { automaticActivityDetection: {} }
        } }));
        ws.onmessage = async (ev) => {
          let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text()); } catch (e) { return; }
          if (m.setupComplete && !done) { done = true; clearTimeout(timer); this.ready = true; resolve(); return; }
          this.h.onMessage(m);
        };
        ws.onerror = () => fail(new Error('socket'));
        ws.onclose = (ev) => { clearTimeout(timer); const was = this.ready; this.ready = false; if (!done) fail(new Error('closed:' + ev.code)); else this.h.onClose(was, ev); };
      });
    }
    sendAudio(b64) { if (this.ready && this.ws.readyState === 1) this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } })); }
    audioEnd() { if (this.ready && this.ws.readyState === 1) this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); }
    close() { this.ready = false; try { this.ws && this.ws.close(1000); } catch (e) {} }
  }

  /* ---------------- Audio: mic capture (16 kHz PCM16) and gapless playback (24 kHz PCM16) ---------------- */
  const WORKLET = `class P extends AudioWorkletProcessor{constructor(){super();this.r=sampleRate/16000;this.buf=[];this.pos=0;this.n=0;this.sum=0;}
  process(i){const c=i[0]&&i[0][0];if(!c)return true;for(let k=0;k<c.length;k++){this.buf.push(c[k]);}
  while(this.pos+1<this.buf.length){const a=Math.floor(this.pos),f=this.pos-a;const v=this.buf[a]*(1-f)+this.buf[a+1]*f;this.out=this.out||[];this.out.push(v);this.sum+=v*v;this.n++;this.pos+=this.r;}
  const d=Math.floor(this.pos);if(d>0){this.buf.splice(0,d);this.pos-=d;}
  if(this.out&&this.out.length>=320){const p=new Int16Array(this.out.length);for(let k=0;k<p.length;k++){const s=Math.max(-1,Math.min(1,this.out[k]));p[k]=s<0?s*32768:s*32767;}
  this.port.postMessage({pcm:p.buffer,rms:Math.sqrt(this.sum/Math.max(1,this.n))},[p.buffer]);this.out=[];this.sum=0;this.n=0;}return true;}}registerProcessor('p',P);`;
  const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };

  const Coach = {
    state: 'idle', muted: false, msg: '', level: 0, log: [], text: '', busyText: false, usage: null,
    ctx: null, stream: null, node: null, prov: null, analyser: null, sources: new Set(), nextT: 0,
    userStop: false, tries: 0, connecting: false, raf: 0, lastSpeechAt: 0,

    set(st, msg) { this.state = st; this.msg = msg || ''; ui(); },

    async start() {
      if (this.connecting || ['connecting', 'listening', 'thinking', 'speaking'].includes(this.state)) return; // no repeated session creation
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.WebSocket || !(window.AudioContext || window.webkitAudioContext)) return this.set('error', 'הדפדפן לא תומך בשיחה קולית. אפשר להשתמש בטקסט.');
      if (!navigator.onLine) return this.set('error', 'אין חיבור לאינטרנט.');
      if (!ws.sess) return this.set('error', 'צריך להתחבר לחשבון כדי לדבר עם המאמן.');
      this.connecting = true; this.userStop = false; this.set('connecting');
      try {
        // Microphone first (must be inside the user's tap), then the paid-nothing token, then the socket.
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        const AC = window.AudioContext || window.webkitAudioContext; this.ctx = this.ctx || new AC(); if (this.ctx.state === 'suspended') await this.ctx.resume();
        const t = await this.token();
        this.prov = new GeminiLive({ onMessage: (m) => this.onMsg(m), onClose: (was, ev) => this.onClose(was, ev) });
        await this.prov.open(t.token, t.model);
        await this.startMic();
        this.set('listening'); this.loop();
      } catch (e) { this.fail(e); } finally { this.connecting = false; }
    },

    async token() {
      let jwt; try { jwt = await wsToken(); } catch (e) { throw Object.assign(new Error('login'), { code: 'login' }); }
      let r; try { r = await fetch(API + 'session', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) { throw Object.assign(new Error('net'), { code: 'net' }); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.error || 'http'), { code: j.error || 'http' + r.status });
      this.usage = { used: j.used, limit: j.limit }; return j;
    },

    async startMic() {
      const src = this.ctx.createMediaStreamSource(this.stream);
      if (this.ctx.audioWorklet) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        try { await this.ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        this.node = new AudioWorkletNode(this.ctx, 'p'); this.node.port.onmessage = (e) => this.onPcm(e.data.pcm, e.data.rms);
        src.connect(this.node); const z = this.ctx.createGain(); z.gain.value = 0; this.node.connect(z); z.connect(this.ctx.destination); // keep node alive, silent
      } else throw new Error('no-worklet');
      this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 256;
    },

    onPcm(buf, rms) {
      if (this.muted) { this.level *= 0.8; return; }
      this.level = Math.max(this.level * 0.7, Math.min(1, rms * 8));
      if (rms > 0.02) { this.lastSpeechAt = Date.now(); if (this.state === 'thinking') this.set('listening'); }
      if (this.prov) this.prov.sendAudio(b64(buf));
    },

    onMsg(m) {
      if (m.goAway) { this.reconnect('הסשן עומד להסתיים'); return; }
      const sc = m.serverContent; if (!sc) return;
      if (sc.interrupted) { this.flush(); this.set('listening'); } // user spoke over the coach: stop talking immediately
      if (sc.inputTranscription && sc.inputTranscription.text) { this.addLog('user', sc.inputTranscription.text); if (this.state === 'listening') this.set('thinking'); }
      if (sc.outputTranscription && sc.outputTranscription.text) this.addLog('coach', sc.outputTranscription.text);
      const parts = sc.modelTurn && sc.modelTurn.parts;
      if (parts) for (const p of parts) if (p.inlineData && p.inlineData.data && /audio\/pcm/.test(p.inlineData.mimeType || '')) this.play(p.inlineData.data);
      if (sc.turnComplete) this.afterPlay();
    },

    play(b) {
      const bin = atob(b), n = bin.length >> 1, f = new Float32Array(n);
      for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v > 32767) v -= 65536; f[i] = v / 32768; }
      const buf = this.ctx.createBuffer(1, n, 24000); buf.copyToChannel(f, 0);
      const s = this.ctx.createBufferSource(); s.buffer = buf; s.connect(this.ctx.destination);
      if (this.analyser) { try { s.connect(this.analyser); } catch (e) {} }
      const t = Math.max(this.ctx.currentTime + 0.02, this.nextT); s.start(t); this.nextT = t + buf.duration;
      this.sources.add(s); s.onended = () => { this.sources.delete(s); if (!this.sources.size) this.afterPlay(); };
      if (this.state !== 'speaking') this.set('speaking');
    },
    flush() { this.sources.forEach((s) => { try { s.onended = null; s.stop(); } catch (e) {} }); this.sources.clear(); this.nextT = 0; },
    afterPlay() { if (!this.sources.size && this.state === 'speaking') this.set('listening'); },

    addLog(who, t) { const l = this.log, last = l[l.length - 1]; if (last && last.who === who) last.t += t; else l.push({ who, t }); if (l.length > 60) l.shift(); logUi(); },

    onClose(was, ev) {
      if (this.userStop) return;
      if (was) this.reconnect('החיבור נותק');
    },
    async reconnect(why) {
      if (this.userStop || this.connecting) return; this.teardown(false);
      if ((this.tries || 0) >= 2) { this.tries = 0; return this.set('disconnected', why + '. אפשר להתחבר מחדש (השיחה הקודמת לא נשמרת בצד המאמן).'); }
      this.tries = (this.tries || 0) + 1; this.set('connecting', 'מתחבר מחדש…');
      await new Promise((r) => setTimeout(r, 800 * this.tries)); if (this.userStop) return;
      this.state = 'idle'; await this.start(); if (this.state === 'listening') this.tries = 0;
    },

    fail(e) {
      this.teardown(false);
      const c = e && e.code, name = e && e.name;
      const map = { login: 'צריך להתחבר לחשבון כדי לדבר עם המאמן.', login_required: 'ההתחברות פגה. התחבר שוב דרך התפריט.', net: 'אין חיבור לשרת. בדוק רשת ונסה שוב.', daily_limit: 'הגעת למגבלת השיחות היומית. אפשר להמשיך בטקסט.', too_fast: 'רגע, נסה שוב בעוד כמה שניות.', provider_limit: 'מכסת ה-AI החינמית הנוכחית נגמרה. נסה מאוחר יותר או כתוב בטקסט.', not_configured: 'שירות ה-AI עדיין לא הוגדר בשרת (חסר GEMINI_API_KEY).', upstream_error: 'שירות ה-AI לא זמין כרגע. נסה שוב או כתוב בטקסט.' };
      let msg = map[c];
      if (!msg && (name === 'NotAllowedError' || name === 'SecurityError')) msg = 'אין הרשאה למיקרופון. אשר אותה בהגדרות האתר בדפדפן ונסה שוב.';
      if (!msg && name === 'NotFoundError') msg = 'לא נמצא מיקרופון במכשיר.';
      if (!msg && e && /closed:|socket|timeout/.test(e.message || '')) msg = 'ההתחברות לשירות הקול נכשלה (ייתכן שהדגם לא זמין). אפשר להמשיך בטקסט.';
      this.set('error', (msg || 'משהו השתבש. נסה שוב או כתוב בטקסט.') + ' [' + (c || name || (e && e.message) || '?') + ']');
    },

    stop() { this.userStop = true; this.tries = 0; this.teardown(true); this.set('idle'); },
    teardown(closeCtx) {
      cancelAnimationFrame(this.raf); this.flush();
      try { this.prov && this.prov.audioEnd(); } catch (e) {} try { this.prov && this.prov.close(); } catch (e) {} this.prov = null;
      try { this.node && this.node.disconnect(); } catch (e) {} this.node = null;
      try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch (e) {} this.stream = null;
      if (closeCtx && this.ctx) { try { this.ctx.close(); } catch (e) {} this.ctx = null; }
      this.level = 0; this.muted = false;
    },
    toggleMute() { if (!this.stream) return; this.muted = !this.muted; this.stream.getAudioTracks().forEach((t) => (t.enabled = !this.muted)); if (this.muted && this.prov) this.prov.audioEnd(); ui(); },

    loop() {
      const el = () => document.getElementById('cv-orb');
      const tick = () => {
        let lvl = this.level;
        if (this.state === 'speaking' && this.analyser) { const d = new Uint8Array(this.analyser.frequencyBinCount); this.analyser.getByteTimeDomainData(d); let s = 0; for (const v of d) { const x = (v - 128) / 128; s += x * x; } lvl = Math.min(1, Math.sqrt(s / d.length) * 5); }
        const o = el(); if (o && !matchMedia('(prefers-reduced-motion: reduce)').matches) o.style.setProperty('--lvl', lvl.toFixed(2));
        this.raf = requestAnimationFrame(tick);
      };
      cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(tick);
    },

    /* ---- text fallback (also works when voice is unavailable or the free quota is used up) ---- */
    async sendText() {
      const inp = document.getElementById('cv-in'), t = ((inp && inp.value) || this.text || '').trim();
      if (!t || this.busyText) return;
      if (!ws.sess) { this.msg = 'צריך להתחבר לחשבון כדי לשוחח עם המאמן.'; ui(); return; }
      this.text = ''; if (inp) inp.value = ''; this.chat = this.chat || []; this.chat.push({ role: 'user', text: t }); this.log.push({ who: 'user', t }); this.busyText = true; logUi(); ui();
      try {
        let jwt; try { jwt = await wsToken(); } catch (e) { throw Object.assign(new Error('x'), { code: 'login' }); }
        let r; try { r = await fetch(API + 'text', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: this.chat.slice(-12) }) }); } catch (e) { throw Object.assign(new Error('x'), { code: 'net' }); }
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw Object.assign(new Error('x'), { code: j.error || (r.status === 404 ? 'functions_missing' : 'http' + r.status), status: r.status });
        this.chat.push({ role: 'model', text: j.text }); this.log.push({ who: 'coach', t: j.text });
      } catch (e) {
        this.chat.pop(); const c = e.code, M = { login: 'צריך להתחבר לחשבון (תפריט ☰) כדי לשוחח עם המאמן.', login_required: 'ההתחברות פגה. התחבר שוב דרך התפריט.', net: 'אין חיבור לשרת.', not_configured: 'מפתח ה-AI עדיין לא מוגדר בשרת (GEMINI_API_KEY).', functions_missing: 'פונקציות השרת של המאמן לא פורסמו באתר.', daily_limit: 'הגעת למגבלה היומית.', provider_limit: 'מכסת ה-AI החינמית נגמרה כרגע.', upstream_error: 'שירות ה-AI החזיר שגיאה.', bad_request: 'הבקשה לא תקינה.' };
        this.log.push({ who: 'sys', t: (M[c] || 'לא הצלחתי לענות כרגע.') + ' [' + (c || '?') + (e.status ? ' ' + e.status : '') + ']' });
      }
      this.busyText = false; logUi(); ui();
    },
    clear() { this.log = []; this.chat = []; logUi(); }
  };

  /* ---------------- UI (re-rendered safely: all state lives in Coach, markup is rebuilt from it) ---------------- */
  const CSS = `
  .cv{position:relative;overflow:hidden}.cv-orbw{display:flex;justify-content:center;padding:18px 0 8px}
  .cv-orb{--lvl:0;width:132px;height:132px;border-radius:50%;position:relative;background:radial-gradient(circle at 35% 30%,#d8b8ff,#8a4dff 45%,#3b1790 85%);box-shadow:0 0 calc(24px + var(--lvl)*46px) rgba(157,107,255,calc(.35 + var(--lvl)*.5)),inset 0 0 30px rgba(255,255,255,.14);transform:scale(calc(1 + var(--lvl)*.12));transition:box-shadow .12s,transform .12s,filter .3s}
  .cv-orb::after{content:"";position:absolute;inset:-10px;border-radius:50%;border:1px solid rgba(157,107,255,.35)}
  .cv-orb[data-s=idle],.cv-orb[data-s=disconnected]{filter:saturate(.45) brightness(.8)}.cv-orb[data-s=error]{filter:hue-rotate(150deg) saturate(.8)}
  .cv-orb[data-s=connecting],.cv-orb[data-s=thinking]{animation:cvp 1.4s ease-in-out infinite}
  @keyframes cvp{50%{transform:scale(1.07);filter:brightness(1.2)}}
  @media (prefers-reduced-motion:reduce){.cv-orb,.cv-orb[data-s=connecting],.cv-orb[data-s=thinking]{animation:none;transition:none;transform:none}}
  .cv-st{text-align:center;font-weight:700;font-size:16px;margin:6px 0 2px}.cv-msg{text-align:center;color:var(--ink-soft);font-size:13px;min-height:18px;margin:2px 8px 10px}
  .cv-row{display:flex;gap:8px}.cv-row .add{flex:1;min-height:52px;margin:0}
  .cv-log{max-height:240px;overflow:auto;margin-top:10px;display:flex;flex-direction:column;gap:6px;-webkit-overflow-scrolling:touch}
  .cv-b{unicode-bidi:plaintext;padding:8px 11px;border-radius:12px;font-size:14px;line-height:1.45;max-width:88%;overflow-wrap:anywhere}.cv-b.user{align-self:flex-start;background:rgba(var(--glass),.08)}.cv-b.coach{align-self:flex-end;background:rgba(157,107,255,.18)}.cv-b.sys{align-self:center;color:var(--ink-soft);font-size:12.5px}
  .cv-tx{display:flex;gap:8px;margin-top:10px}.cv-tx input{text-align:start;unicode-bidi:plaintext;flex:1;min-width:0;min-height:48px;font-size:16px;border-radius:12px;border:1px solid var(--line);background:rgba(var(--glass),.06);color:var(--ink);padding:0 12px}.cv-tx button{min-height:48px;min-width:64px;margin:0}`;
  function css() { if (!document.getElementById('cv-css')) { const s = document.createElement('style'); s.id = 'cv-css'; s.textContent = CSS; document.head.appendChild(s); } }
  const live = () => ['connecting', 'listening', 'thinking', 'speaking'].includes(Coach.state);
  function logHtml() { return Coach.log.map((m) => `<div class="cv-b ${m.who}" dir="auto">${esc(m.t)}</div>`).join('') || '<div class="wk-sub" style="text-align:center">עוד אין שיחה. לחץ "דבר עם המאמן" או כתוב למטה.</div>'; }
  function html() {
    const c = Coach, on = live(), busy = c.state === 'connecting';
    return `<div class="card cv" dir="rtl" id="cv-card"><label>🎙️ שיחה עם המאמן</label>
      <div class="cv-orbw"><div class="cv-orb" id="cv-orb" data-s="${c.state}" role="img" aria-label="מצב המאמן: ${STATES[c.state]}"></div></div>
      <div class="cv-st" id="cv-st" aria-live="polite">${STATES[c.state]}${c.muted ? ' (מושתק)' : ''}</div>
      <div class="cv-msg" id="cv-msg">${esc(c.msg)}</div>
      <div class="cv-row" id="cv-btns">${on ? `<button class="add" style="background:rgba(var(--glass),.08);color:var(--ink);border:1px solid var(--line)" onclick="cvMute()" ${busy ? 'disabled' : ''}>${c.muted ? '🔊 בטל השתקה' : '🔇 השתק'}</button><button class="add" style="background:#b3263e" onclick="cvStop()">⏹ סיים</button>` : `<button class="add" onclick="cvStart()">🎤 ${c.state === 'error' || c.state === 'disconnected' ? 'נסה שוב' : 'דבר עם המאמן'}</button>`}</div>
      <div class="cv-log" id="cv-log" aria-live="polite">${logHtml()}</div>
      <div class="cv-tx"><input id="cv-in" type="text" dir="auto" enterkeyhint="send" placeholder="או כתוב למאמן…" maxlength="500" ${c.busyText ? 'disabled' : ''} onkeydown="if(event.key==='Enter')cvSend()"><button class="add" onclick="cvSend()" ${c.busyText ? 'disabled' : ''}>שלח</button></div>
      <div class="wk-sub" style="margin-top:8px">${c.usage ? `שיחה ${c.usage.used} מתוך ${c.usage.limit} היום. ` : ''}${c.log.length ? '<a href="#" onclick="cvClear();return false" style="color:var(--accent)">נקה שיחה</a> · ' : ''}השיחה לא נשמרת. אין עדיין גישה לנתוני הדשבורד שלך.</div></div>`;
  }
  function ui() { const card = document.getElementById('cv-card'); if (!card) return; const keep = (document.getElementById('cv-in') || {}).value, focus = document.activeElement && document.activeElement.id === 'cv-in'; card.outerHTML = html(); const i = document.getElementById('cv-in'); if (i && keep) i.value = keep; if (i && focus) i.focus(); if (live()) Coach.loop(); }
  function logUi() { const l = document.getElementById('cv-log'); if (!l) return; const near = l.scrollHeight - l.scrollTop - l.clientHeight < 60; l.innerHTML = logHtml(); if (near) l.scrollTop = l.scrollHeight; }

  window.cvStart = () => Coach.start(); window.cvStop = () => Coach.stop(); window.cvMute = () => Coach.toggleMute(); window.cvSend = () => Coach.sendText(); window.cvClear = () => Coach.clear();
  window.__coach = Coach; // for tests/diagnostics

  css();
  const _prev = renderCoach;
  renderCoach = function () {
    let h = _prev(); h = h.replace('(כללים קבועים, לא AI חיצוני)', '(כללים קבועים). בהמשך: שיחה עם מאמן AI.');
    const k = '<div class="card"><label>', i = h.indexOf(k); return i < 0 ? h + html() : h.slice(0, i) + html() + h.slice(i);
  };
  addEventListener('pagehide', () => { if (live()) Coach.stop(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && live() && Coach.state !== 'speaking') { /* keep session; mic indicator shows it is active */ } });
})();
