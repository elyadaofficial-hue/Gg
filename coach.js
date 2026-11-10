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

    set(st, msg, code) { this.state = st; this.msg = msg || ''; this.code = code || ''; ui(); },

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
      this.set('error', msg || 'משהו השתבש. נסה שוב או כתוב בטקסט.', String(c || name || (e && e.message) || '?'));
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

    loop() { Orb.kick(); },

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
        if (!r.ok) throw Object.assign(new Error('x'), { code: j.error || (r.status === 404 ? 'functions_missing' : 'http' + r.status), status: j.code || r.status, detail: j.detail });
        this.chat.push({ role: 'model', text: j.text }); this.log.push({ who: 'coach', t: j.text });
      } catch (e) {
        this.chat.pop(); const c = e.code, M = { login: 'צריך להתחבר לחשבון (תפריט ☰) כדי לשוחח עם המאמן.', login_required: 'ההתחברות פגה. התחבר שוב דרך התפריט.', net: 'אין חיבור לשרת.', not_configured: 'מפתח ה-AI עדיין לא מוגדר בשרת (GEMINI_API_KEY).', functions_missing: 'פונקציות השרת של המאמן לא פורסמו באתר.', daily_limit: 'הגעת למגבלה היומית.', provider_limit: 'מכסת ה-AI החינמית נגמרה כרגע.', upstream_error: 'שירות ה-AI החזיר שגיאה.', bad_request: 'הבקשה לא תקינה.' };
        this.log.push({ who: 'sys', t: (e.status === 503 ? 'שירות ה-AI עמוס כרגע. נסה שוב בעוד רגע.' : M[c] || 'לא הצלחתי לענות כרגע.'), code: (c || '?') + (e.status ? ' ' + e.status : '') });
      }
      this.busyText = false; logUi(); ui();
    },
    clear() { this.log = []; this.chat = []; logUi(); }
  };

  /* ---------------- Animated orb (canvas): state-driven colour, mic/speech reactive ---------------- */
  const PAL = { idle: [268, 290, 45, 62], connecting: [250, 200, 80, 62], listening: [195, 268, 85, 62], thinking: [285, 325, 85, 66], speaking: [305, 262, 90, 68], error: [8, 28, 80, 58], disconnected: [230, 240, 12, 45] };
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const Orb = {
    cv: null, x: null, raf: 0, run: false, t: 0, lvl: 0, last: 0, h1: 268, h2: 290, sat: 45, lig: 62, parts: [],
    init() {
      const c = document.getElementById('cv-cv'); if (!c) return; this.cv = c; this.x = c.getContext('2d');
      const d = Math.min(devicePixelRatio || 1, 2), w = c.clientWidth || 220; c.width = c.height = Math.round(w * d);
      if (!this.parts.length) this.parts = Array.from({ length: 26 }, () => ({ a: Math.random() * 6.283, r: Math.random(), s: (0.2 + Math.random() * 0.6) * (Math.random() < 0.5 ? -1 : 1), z: 1 + Math.random() * 1.8, ph: Math.random() * 6 }));
    },
    kick() { if (!panelOpen) return; if (!this.cv || !document.body.contains(this.cv)) this.init(); if (!this.cv) return; if (reduced()) { this.draw(0); return; } if (this.run) return; this.run = true; this.last = performance.now(); const f = (n) => { if (!this.run) return; this.raf = requestAnimationFrame(f); if (document.hidden || n - this.last < 24) return; const dt = Math.min(0.05, (n - this.last) / 1000); this.last = n; this.draw(dt); }; this.raf = requestAnimationFrame(f); },
    halt() { this.run = false; cancelAnimationFrame(this.raf); },
    target(st, t) {
      if (st === 'listening') return Coach.muted ? 0.04 : Math.max(0.1, Coach.level);
      if (st === 'speaking') { const an = Coach.analyser; if (an) { const d = new Uint8Array(an.frequencyBinCount); an.getByteTimeDomainData(d); let s = 0; for (const v of d) { const q = (v - 128) / 128; s += q * q; } return Math.min(1, 0.2 + Math.sqrt(s / d.length) * 5); } return 0.5; }
      if (st === 'thinking') return 0.3 + 0.12 * Math.sin(t * 6);
      if (st === 'connecting') return 0.32 + 0.1 * Math.sin(t * 4);
      if (st === 'error') return 0.12 + 0.05 * Math.sin(t * 3);
      return 0.09 + 0.04 * Math.sin(t * 1.2);
    },
    draw(dt) {
      const x = this.x, s = this.cv.width, c = s / 2, st = Coach.state; this.t += dt; const t = this.t;
      const k = Math.min(1, dt * 6) || 1, P = PAL[st] || PAL.idle; this.h1 += (P[0] - this.h1) * k; this.h2 += (P[1] - this.h2) * k; this.sat += (P[2] - this.sat) * k; this.lig += (P[3] - this.lig) * k;
      this.lvl += (this.target(st, t) - this.lvl) * (Math.min(1, dt * 9) || 1); const L = this.lvl;
      const hs = (h, a, l) => `hsla(${h.toFixed(0)},${this.sat.toFixed(0)}%,${(l == null ? this.lig : l).toFixed(0)}%,${a})`;
      x.clearRect(0, 0, s, s); x.globalCompositeOperation = 'source-over';
      const R = s * 0.23 * (1 + L * 0.2 + Math.sin(t * 1.3) * 0.02);
      let g = x.createRadialGradient(c, c, R * 0.3, c, c, s * 0.5); g.addColorStop(0, hs(this.h1, 0.42 + L * 0.4)); g.addColorStop(0.6, hs(this.h2, 0.12 + L * 0.12)); g.addColorStop(1, hs(this.h2, 0)); x.fillStyle = g; x.fillRect(0, 0, s, s);
      x.globalCompositeOperation = 'lighter';
      for (let k2 = 0; k2 < 3; k2++) {
        x.beginPath(); const N = 80;
        for (let i = 0; i <= N; i++) { const a = (i / N) * 6.2832, n = Math.sin(a * 3 + t * (0.9 + k2 * 0.5) + k2 * 2) * 0.5 + Math.sin(a * 5 - t * (1.3 + k2 * 0.4)) * 0.3 + Math.sin(a * 2 + t * 0.7 + k2) * 0.4, r = R * (1 + (0.08 + L * 0.34) * n) * (1 - k2 * 0.07); const px = c + Math.cos(a) * r, py = c + Math.sin(a) * r; i ? x.lineTo(px, py) : x.moveTo(px, py); }
        x.closePath(); g = x.createRadialGradient(c - R * 0.25, c - R * 0.3, R * 0.1, c, c, R * 1.25); g.addColorStop(0, hs(k2 === 1 ? this.h2 : this.h1, 0.5, Math.min(72, this.lig + 6))); g.addColorStop(1, hs(k2 === 2 ? this.h1 : this.h2, 0.28, this.lig - 14)); x.fillStyle = g; x.fill();
      }
      x.lineCap = 'round'; x.lineWidth = Math.max(2, s * 0.009);
      for (let i = 0; i < 56; i++) { const a = (i / 56) * 6.2832 + t * 0.12, amp = L * (0.35 + 0.65 * Math.abs(Math.sin(i * 1.7 + t * 3.1 + Math.sin(i + t)))), r0 = R * 1.3, r1 = r0 + R * (0.06 + amp * 0.55); x.strokeStyle = hs(i % 2 ? this.h1 : this.h2, 0.25 + L * 0.65, 72); x.beginPath(); x.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0); x.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1); x.stroke(); }
      const boost = st === 'thinking' ? 1.8 : st === 'connecting' ? 1.2 : 0.4;
      for (const q of this.parts) { q.a += q.s * dt * (boost + L * 2.2); const rr = R * (1.7 + q.r * 0.75 + Math.sin(t * q.z + q.ph) * 0.07); x.fillStyle = hs(q.r > 0.5 ? this.h1 : this.h2, 0.3 + 0.45 * Math.abs(Math.sin(t * 1.6 + q.ph)), 78); x.beginPath(); x.arc(c + Math.cos(q.a) * rr, c + Math.sin(q.a) * rr, s * 0.0055 * q.z, 0, 6.2832); x.fill(); }
      if (st === 'connecting') { x.strokeStyle = hs(this.h1, 0.9, 80); x.lineWidth = s * 0.012; x.beginPath(); x.arc(c, c, R * 1.18, t * 4, t * 4 + 1.6); x.stroke(); }
      x.globalCompositeOperation = 'source-over'; g = x.createRadialGradient(c - R * 0.35, c - R * 0.4, 0, c - R * 0.35, c - R * 0.4, R * 0.5); g.addColorStop(0, 'rgba(255,255,255,.5)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.beginPath(); x.arc(c, c, R, 0, 6.2832); x.fill();
    }
  };

  /* ---------------- UI: edge handle + slide-in panel, mounted on <body> so it survives tab changes and re-renders ---------------- */
  let panelOpen = false, built = false;
  const CSS = `
  #cv-handle{position:fixed;right:0;top:42%;z-index:45;width:36px;height:96px;padding:0;border:1px solid rgba(157,107,255,.45);border-right:0;border-radius:16px 0 0 16px;background:linear-gradient(160deg,rgba(60,28,130,.92),rgba(24,10,58,.92));color:#EDE8FF;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;cursor:pointer;box-shadow:-4px 0 22px rgba(120,70,255,.35);-webkit-tap-highlight-color:transparent}
  #cv-handle::before{content:"";width:10px;height:10px;border-radius:50%;background:var(--cvc,#9d6bff);box-shadow:0 0 10px var(--cvc,#9d6bff)}
  #cv-handle[data-live="1"]::before{animation:cvdot 1.2s ease-in-out infinite}@keyframes cvdot{50%{transform:scale(1.5);opacity:.6}}
  #cv-handle span{font-size:18px;line-height:1}#cv-root[data-open="1"] #cv-handle{display:none}
  #cv-back{position:fixed;inset:0;z-index:7999;background:rgba(5,2,15,.55);opacity:0;pointer-events:none;transition:opacity .25s}#cv-root[data-open="1"] #cv-back{opacity:1;pointer-events:auto}
  #cv-panel{position:fixed;top:0;bottom:0;right:0;z-index:8000;width:min(94vw,430px);height:100dvh;display:flex;flex-direction:column;background:radial-gradient(120% 60% at 50% 0%,rgba(90,40,200,.35),transparent 60%),#0d0820;color:#EDE8FF;border-left:1px solid rgba(157,107,255,.35);box-shadow:-10px 0 40px rgba(0,0,0,.55);transform:translateX(105%);transition:transform .32s cubic-bezier(.2,.9,.3,1);padding-top:env(safe-area-inset-top,0px);visibility:hidden;direction:rtl}
  #cv-root[data-open="1"] #cv-panel{transform:none;visibility:visible}
  @media (prefers-reduced-motion:reduce){#cv-panel,#cv-back{transition:none}#cv-handle[data-live="1"]::before{animation:none}}
  .cvh{display:flex;align-items:center;gap:8px;padding:10px 12px}.cvh b{flex:1;font-size:17px}.cvh button{min-width:44px;min-height:44px;margin:0;border-radius:12px;border:1px solid rgba(157,107,255,.3);background:rgba(255,255,255,.06);color:#EDE8FF;font-size:16px;cursor:pointer;padding:0 10px;width:auto}
  #cv-cv{display:block;width:min(56vw,230px);height:min(56vw,230px);margin:0 auto;flex:none}
  .cv-st{text-align:center;font-weight:700;font-size:16px}.cv-msg{text-align:center;color:#B9AEDD;font-size:13px;min-height:18px;margin:2px 14px 6px}.cv-code{display:inline-block;margin-inline-start:6px;font-size:11px;opacity:.7;direction:ltr;unicode-bidi:isolate}
  .cv-row{display:flex;gap:8px;padding:0 12px}.cv-row button{flex:1;min-height:52px;margin:0;border-radius:14px;border:0;font-size:15px;font-weight:700;cursor:pointer;color:#fff;background:linear-gradient(135deg,#7c3aed,#a855f7);width:auto}
  .cv-row button.sec{background:rgba(255,255,255,.09);border:1px solid rgba(157,107,255,.3)}.cv-row button.end{background:#b3263e}.cv-row button:disabled{opacity:.5}
  .cv-log{flex:1;min-height:60px;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:6px;-webkit-overflow-scrolling:touch}
  .cv-b{padding:8px 11px;border-radius:14px;font-size:15px;line-height:1.5;max-width:88%;overflow-wrap:anywhere}.cv-b.user{align-self:flex-start;background:rgba(255,255,255,.1)}.cv-b.coach{align-self:flex-end;background:rgba(157,107,255,.25)}.cv-b.sys{align-self:center;color:#B9AEDD;font-size:12.5px;text-align:center}
  .cv-tx{display:flex;gap:8px;align-items:center;padding:10px 12px calc(12px + env(safe-area-inset-bottom,0px));border-top:1px solid rgba(157,107,255,.25);background:rgba(10,5,24,.92)}
  #cv-in{flex:1 1 0;min-width:0;width:auto;margin:0;min-height:48px;font-size:16px;border-radius:24px;border:1px solid rgba(157,107,255,.45);background:rgba(255,255,255,.08);color:#fff;padding:0 16px;direction:rtl;text-align:right;unicode-bidi:normal}
  #cv-in::placeholder{color:#9d92c8}#cv-send{flex:none;width:48px;min-width:48px;height:48px;margin:0;padding:0;border-radius:50%;border:0;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;font-size:20px;cursor:pointer}#cv-send:disabled{opacity:.5}
  .cv-foot{font-size:11.5px;color:#9d92c8;text-align:center;padding:0 12px 6px}.cv-foot a{color:#c4a8ff}`;
  const live = () => ['connecting', 'listening', 'thinking', 'speaking'].includes(Coach.state);
  const COL = { idle: '#9d6bff', connecting: '#38bdf8', listening: '#22d3ee', thinking: '#e879f9', speaking: '#f472b6', error: '#f87171', disconnected: '#64748b' };
  function logHtml() { return Coach.log.map((m) => `<div class="cv-b ${m.who}" dir="auto">${esc(m.t)}${m.code ? ` <bdi class="cv-code">${esc(m.code)}</bdi>` : ''}</div>`).join('') || '<div class="cv-b sys">עוד אין שיחה. לחץ "דבר עם המאמן" או כתוב למטה.</div>'; }
  function build() {
    if (built || !document.body) return; built = true;
    const s = document.createElement('style'); s.id = 'cv-css'; s.textContent = CSS; document.head.appendChild(s);
    const r = document.createElement('div'); r.id = 'cv-root'; r.dataset.open = '0';
    r.innerHTML = `<button id="cv-handle" type="button" aria-label="פתח את המאמן" onclick="cvOpen()"><span>🎙️</span></button><div id="cv-back" onclick="cvClose()"></div>
      <aside id="cv-panel" role="dialog" aria-label="המאמן האישי" dir="rtl">
        <div class="cvh"><b>🧠 המאמן שלי</b><button type="button" onclick="cvClear()" aria-label="נקה שיחה" title="נקה שיחה">🧹</button><button type="button" id="cv-x" onclick="cvClose()" aria-label="סגור">✕</button></div>
        <canvas id="cv-cv" role="img" aria-label="מצב המאמן"></canvas>
        <div class="cv-st" id="cv-st" aria-live="polite"></div><div class="cv-msg" id="cv-msg"></div>
        <div class="cv-row" id="cv-btns"></div>
        <div class="cv-log" id="cv-log" aria-live="polite"></div>
        <div class="cv-foot" id="cv-foot"></div>
        <form class="cv-tx" id="cv-form" onsubmit="cvSend();return false"><input id="cv-in" type="text" dir="rtl" enterkeyhint="send" autocomplete="off" placeholder="כתוב למאמן…" maxlength="500"><button id="cv-send" type="submit" aria-label="שלח">➤</button></form>
      </aside>`;
    document.body.appendChild(r); ui(); logUi();
  }
  function ui() {
    const c = Coach, on = live(), h = document.getElementById('cv-handle'); if (!h) return;
    h.dataset.live = on ? '1' : '0'; h.style.setProperty('--cvc', COL[c.state] || COL.idle);
    const st = document.getElementById('cv-st'); if (st) st.textContent = STATES[c.state] + (c.muted ? ' (מושתק)' : '');
    const m = document.getElementById('cv-msg'); if (m) m.innerHTML = esc(c.msg) + (c.code ? `<bdi class="cv-code">${esc(c.code)}</bdi>` : '');
    const b = document.getElementById('cv-btns'); if (b) b.innerHTML = on ? `<button type="button" class="sec" onclick="cvMute()" ${c.state === 'connecting' ? 'disabled' : ''}>${c.muted ? '🔊 בטל השתקה' : '🔇 השתק'}</button><button type="button" class="end" onclick="cvStop()">⏹ סיים</button>` : `<button type="button" onclick="cvStart()">🎤 ${c.state === 'error' || c.state === 'disconnected' ? 'נסה שוב' : 'דבר עם המאמן'}</button>`;
    const f = document.getElementById('cv-foot'); if (f) f.textContent = (c.usage ? `שיחה ${c.usage.used} מתוך ${c.usage.limit} היום · ` : '') + 'השיחה לא נשמרת · אין עדיין גישה לנתוני הדשבורד';
    const send = document.getElementById('cv-send'), inp = document.getElementById('cv-in'); if (send) send.disabled = c.busyText; if (inp) inp.disabled = c.busyText && false;
    const pc = document.getElementById('cv-pagestatus'); if (pc) pc.textContent = STATES[c.state];
    if (panelOpen) Orb.kick();
  }
  function logUi() { const l = document.getElementById('cv-log'); if (!l) return; const near = l.scrollHeight - l.scrollTop - l.clientHeight < 80; l.innerHTML = logHtml(); if (near || Coach.busyText === false) l.scrollTop = l.scrollHeight; }
  function open() { build(); panelOpen = true; document.getElementById('cv-root').dataset.open = '1'; Orb.init(); Orb.kick(); logUi(); setTimeout(() => { const x = document.getElementById('cv-in'); if (x && !live()) { /* don't pop the keyboard automatically */ } const cx = document.getElementById('cv-x'); cx && cx.focus({ preventScroll: true }); }, 50); }
  function close() { panelOpen = false; const r = document.getElementById('cv-root'); if (r) r.dataset.open = '0'; Orb.halt(); const h = document.getElementById('cv-handle'); h && h.focus({ preventScroll: true }); }
  window.cvStart = () => Coach.start(); window.cvStop = () => Coach.stop(); window.cvMute = () => Coach.toggleMute(); window.cvSend = () => Coach.sendText(); window.cvClear = () => Coach.clear(); window.cvOpen = open; window.cvClose = close;
  window.__coach = Coach; // for tests/diagnostics

  const _prev = renderCoach;
  renderCoach = function () {
    let h = _prev(); h = h.replace('(כללים קבועים, לא AI חיצוני)', '(כללים קבועים). בהמשך: שיחה עם מאמן AI.');
    const card = `<div class="card"><label>🎙️ שיחה עם המאמן</label><div class="wk-sub">שיחה קולית וכתובה. הלשונית בקצה המסך זמינה מכל מקום באפליקציה. מצב: <b id="cv-pagestatus">${STATES[Coach.state]}</b></div><button class="add" style="margin-top:10px;min-height:52px" onclick="cvOpen()">🎤 פתח את המאמן</button></div>`;
    const k = '<div class="card"><label>', i = h.indexOf(k); return i < 0 ? h + card : h.slice(0, i) + card + h.slice(i);
  };
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && panelOpen) close(); });
  addEventListener('pagehide', () => { if (live()) Coach.stop(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && panelOpen) Orb.kick(); });
  if (document.body) build(); else addEventListener('DOMContentLoaded', build);
})();
