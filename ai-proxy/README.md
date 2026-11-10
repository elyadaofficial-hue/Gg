# AI proxy (optional) — Cloudflare Worker, free plan is enough for personal use
1. Get a Gemini API key at https://aistudio.google.com/apikey. Use the FREE tier; do not enable billing, so it can never charge you. Free-tier content may be used by Google to improve its products.
2. Cloudflare dashboard -> Workers & Pages -> Create Worker -> paste `worker.js` -> Deploy.
3. Worker -> Settings -> Variables and Secrets: add secret `GEMINI_API_KEY`; add variable `ALLOWED_ORIGIN` = your Dashboard's exact origin (e.g. https://yourname.github.io, no path, no trailing slash); optional `GEMINI_MODEL` (default `gemini-flash-latest`; check the current free Flash model name in AI Studio).
4. Copy the worker URL (https://....workers.dev) into Dashboard -> Nutrition -> "חיבור AI" -> Save.
The key never reaches the app. Only your Dashboard origin can call the worker, and text is capped at 500 characters.

## v10.1 update
`worker.js` now also serves `{mode:'label', image, mime}` (nutrition-label photo -> JSON) and `{mode:'catchup', text}` (free-text day -> meals/activities). Re-paste the file and deploy; variables are unchanged. Legacy `{text}` requests behave exactly as before. Photos are sent to Gemini and not stored by the worker.
