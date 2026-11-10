# AI Coach, Phase 1 (voice MVP): setup

Free path only: Gemini Live API on the free tier. Never enable billing on the Google project.

1. Create a key at https://aistudio.google.com/apikey (billing OFF).
2. In AI Studio, check which **Live** model your key can use. Free-tier model names change and some previews are retired.
3. Netlify, site `elyada-life-dashboard`, Site configuration -> Environment variables:
   - `GEMINI_API_KEY` = your key (mark as secret)
   - `COACH_LIVE_MODEL` = the Live model name from step 2 (default in code: `gemini-live-2.5-flash-preview`, may be retired)
   - optional `GEMINI_MODEL` for the text fallback (default `gemini-flash-latest`)
4. Redeploy with functions: `npm install && npx netlify-cli deploy --prod`. Drag-and-drop does not deploy functions.
5. Open the app on your phone, log in (menu), Coach tab, tap "דבר עם המאמן".

Endpoints: `POST /api/coach/session` (ephemeral token) and `POST /api/coach/text`. Both need the Supabase login, are same-origin only,
and are limited to 12 voice sessions and 80 text messages per user per UTC day (one session per 4 s).
Tests: `npm test` (server) and `node tests/coachvoice.e2e.mjs` (browser, fake socket + synthetic mic).
