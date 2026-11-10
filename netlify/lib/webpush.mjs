// Minimal Web Push (RFC 8030 + VAPID RFC 8292 + aes128gcm RFC 8291) with zero dependencies.
import crypto from 'node:crypto';

export const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64url'),
  dec: (s) => Buffer.from(String(s), 'base64url'),
};

// Only real push services. Prevents the function being used to POST to arbitrary hosts.
const ALLOWED_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
export function isAllowedEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && ALLOWED_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

function vapidKeyObject(publicKeyB64u, privateKeyB64u) {
  const pub = b64u.dec(publicKeyB64u);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be an uncompressed P-256 point (65 bytes)');
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33, 65)), d: privateKeyB64u },
    format: 'jwk',
  });
}

export function vapidHeaders(endpoint, { publicKey, privateKey, subject }, nowMs = Date.now()) {
  const aud = new URL(endpoint).origin;
  const head = b64u.enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u.enc(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: vapidKeyObject(publicKey, privateKey), dsaEncoding: 'ieee-p1363' });
  return { Authorization: `vapid t=${head}.${body}.${b64u.enc(sig)}, k=${publicKey}` };
}

// RFC 8291 aes128gcm. `ephemeral` / `salt` are injectable only so the RFC test vector can be verified.
export function encryptPayload(plaintext, subscriptionKeys, { ephemeral, salt } = {}) {
  const uaPublic = b64u.dec(subscriptionKeys.p256dh);
  const authSecret = b64u.dec(subscriptionKeys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');
  const ecdh = ephemeral ? null : crypto.createECDH('prime256v1');
  if (ecdh) ecdh.generateKeys();
  const asPublic = ephemeral ? b64u.dec(ephemeral.publicKey) : ecdh.getPublicKey();
  const secret = ephemeral
    ? (() => { const e = crypto.createECDH('prime256v1'); e.setPrivateKey(b64u.dec(ephemeral.privateKey)); return e.computeSecret(uaPublic); })()
    : ecdh.computeSecret(uaPublic);
  const s = salt ? b64u.dec(salt) : crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, s, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, s, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]); // 0x02 = last (only) record
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([s, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

// Result: { ok, status, gone } ; gone=true means the subscription is dead and must be deleted.
export async function sendPush(sub, payloadObj, vapid, { ttl = 900, topic = 'evening-reset', urgency = 'high', fetchImpl = fetch } = {}) {
  if (!isAllowedEndpoint(sub.endpoint)) return { ok: false, status: 0, gone: true, error: 'endpoint not allowed' };
  const body = encryptPayload(JSON.stringify(payloadObj), sub.keys);
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: { ...vapidHeaders(sub.endpoint, vapid), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgency, Topic: topic },
    body,
  });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}
