import { handleCoach } from '../lib/coach.mjs';

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default async (req) => {
  const url = new URL(req.url), route = url.pathname.replace(/^\/api\/coach\/?/, '');
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) return json(403, { error: 'forbidden' }); // same-origin only
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
  try { const r = await handleCoach(route, req); return json(r.status, r.json); }
  catch (e) { console.error('coach-api', e && e.message); return json(500, { error: 'server error' }); }
};
export const config = { path: '/api/coach/*' };
