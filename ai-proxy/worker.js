// Cloudflare Worker: secure proxy between the Dashboard and the Gemini API.
// The Gemini key lives ONLY here as a secret (never in the app).
// v10.1: also handles {mode:'label', image(base64), mime} (nutrition-label reading) and {mode:'catchup', text, date} (retro day organiser).
// Env: GEMINI_API_KEY (secret), ALLOWED_ORIGIN (e.g. https://yourname.github.io), GEMINI_MODEL (optional, default gemini-flash-latest)
const PROMPT = `You are a nutrition database for a food diary. The user text (Hebrew or English) lists foods eaten.
Return ONLY JSON: {"items":[{"name":string,"grams":number,"gramsEstimated":boolean,"per100":{"calories":number,"protein":number,"carbs":number,"fat":number,"cholesterol":number}}]}
Rules: one item per distinct food; "name" short, generic, singular, in the user's language; per100 = values per 100 g of the food as eaten (cooked if cooked), calories in kcal, cholesterol in mg;
if the user gave a weight use it (gramsEstimated=false), otherwise estimate a typical portion in grams (gramsEstimated=true); do NOT add totals; use null for unknown values; no commentary.`;
const LABEL_PROMPT = `You read a FOOD NUTRITION LABEL from a photo (labels may be Hebrew, English or other languages).
Return ONLY JSON: {"readable":boolean,"name":string|null,"servingSize":{"amount":number|null,"unit":"g"|"ml"|"other"|null,"text":string|null},"per100":{"calories":number|null,"protein":number|null,"carbs":number|null,"fat":number|null,"cholesterol":number|null}|null,"perServing":{same keys}|null,"notes":string}
Rules: transcribe ONLY numbers that are printed on the label. Never estimate, never compute, never fill a missing value: use null. calories in kcal (if only kJ is printed, calories=null). protein/carbs/fat in grams. cholesterol in mg. Fill per100 from the "per 100 g / 100 ml" column and perServing from the per-serving column (null if that column does not exist). servingSize.unit is "g" or "ml" only if the serving weight/volume is printed, otherwise "other" with the printed text. name = product name only if clearly visible. readable=false if the image is not a nutrition label or too blurry/cropped to read. notes = one short Hebrew sentence about anything uncertain, else "".`;
const CATCHUP_PROMPT = `You organise a person's free-form (Hebrew or English) description of what they ate and did on one day, for a diary.
Return ONLY JSON: {"items":[{"name":string,"grams":number,"gramsEstimated":boolean,"time":string|null,"per100":{"calories":number,"protein":number,"carbs":number,"fat":number,"cholesterol":number}}],"activities":[{"kind":"workout"|"sleep"|"studies"|"other","title":string,"minutes":number|null,"hours":number|null}],"unclear":[string]}
Rules: only include what the person actually said; do not invent meals. One item per distinct food (name short, generic, singular, in the user's language). per100 = values per 100 g as eaten, calories in kcal, cholesterol in mg, null if unknown. If a weight was given use it (gramsEstimated=false), else estimate a typical portion (gramsEstimated=true). time "HH:MM" only if stated. activities: workout (title like Push/Pull/Legs or a short name), sleep (hours), studies (minutes), anything else = "other". Put fragments you could not interpret in "unclear" (short). No totals, no commentary.`;
async function gemini(env, parts) {
  const model = env.GEMINI_MODEL || 'gemini-flash-latest';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } })
  });
  if (!r.ok) return null;
  try { const d = await r.json(); return JSON.parse((d.candidates?.[0]?.content?.parts?.[0]?.text || '').replace(/```json|```/g, '').trim()); } catch (e) { return null; }
}
export default {
  async fetch(req, env) {
    const origin = env.ALLOWED_ORIGIN || '';
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST' || !origin || req.headers.get('Origin') !== origin) return new Response('forbidden', { status: 403, headers: cors });
    let body = {};
    try { body = await req.json(); } catch (e) {}
    const ok = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    const mode = body.mode || 'food';
    if (mode === 'label') {
      const img = typeof body.image === 'string' ? body.image : '';
      const mime = ['image/jpeg', 'image/png', 'image/webp'].includes(body.mime) ? body.mime : '';
      if (!img || !mime || img.length > 3_000_000 || !/^[A-Za-z0-9+/=]+$/.test(img)) return new Response('bad request', { status: 400, headers: cors });
      const out = await gemini(env, [{ text: LABEL_PROMPT }, { inlineData: { mimeType: mime, data: img } }]);
      if (!out || typeof out !== 'object') return new Response('bad upstream data', { status: 502, headers: cors });
      return ok(out);
    }
    if (mode === 'catchup') {
      const text = String(body.text || '').trim().slice(0, 2000);
      if (!text) return new Response('bad request', { status: 400, headers: cors });
      const out = await gemini(env, [{ text: CATCHUP_PROMPT + '\n\nUser text:\n' + text }]);
      if (!out || typeof out !== 'object') return new Response('bad upstream data', { status: 502, headers: cors });
      return ok({ items: out.items || [], activities: out.activities || [], unclear: out.unclear || [] });
    }
    const text = String(body.text || '').trim().slice(0, 500);
    if (!text) return new Response('bad request', { status: 400, headers: cors });
    const model = env.GEMINI_MODEL || 'gemini-flash-latest';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT + '\n\nUser text:\n' + text }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } })
    });
    if (!r.ok) return new Response('upstream error', { status: 502, headers: cors });
    let items = [];
    try {
      const d = await r.json();
      const raw = (d.candidates?.[0]?.content?.parts?.[0]?.text || '').replace(/```json|```/g, '').trim();
      items = JSON.parse(raw).items || [];
    } catch (e) { return new Response('bad upstream data', { status: 502, headers: cors }); }
    return new Response(JSON.stringify({ items }), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
};
