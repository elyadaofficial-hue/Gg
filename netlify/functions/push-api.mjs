import { env, upsertSubscription, removeSubscription, markAction, sendTest } from '../lib/core.mjs';

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default async (req) => {
  const url = new URL(req.url), route = url.pathname.replace(/^\/api\/push\/?/, '');
  // Same-origin only (the app and its functions share one origin).
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) return json(403, { error: 'forbidden' });
  try {
    if (route === 'config' && req.method === 'GET') {
      const k = env('VAPID_PUBLIC_KEY');
      return k ? json(200, { publicKey: k }) : json(503, { error: 'VAPID keys not configured' });
    }
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
    const body = await req.json().catch(() => null);
    if (!body) return json(400, { error: 'bad json' });
    let r;
    if (route === 'subscribe') r = await upsertSubscription(body);
    else if (route === 'unsubscribe') r = await removeSubscription(body.endpoint);
    else if (route === 'cancel') r = await markAction(body.endpoint, 'cancel');
    else if (route === 'skip') r = await markAction(body.endpoint, body.undo ? 'unskip' : 'skip');
    else if (route === 'test') r = await sendTest(body.endpoint);
    else return json(404, { error: 'not found' });
    return json(r.status, r.json);
  } catch (e) {
    console.error('push-api', e);
    return json(500, { error: 'server error' });
  }
};
export const config = { path: '/api/push/*' };
