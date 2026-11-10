import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptPayload, vapidHeaders, b64u, isAllowedEndpoint } from '../netlify/lib/webpush.mjs';

// RFC 8291 Appendix A
const V = {
  plaintext: Buffer.from('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24', 'base64url').toString(),
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg', salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
test('RFC 8291 test vector matches byte for byte', () => {
  const out = encryptPayload(V.plaintext, { p256dh: V.uaPublic, auth: V.auth }, { ephemeral: { publicKey: V.asPublic, privateKey: V.asPrivate }, salt: V.salt });
  assert.equal(b64u.enc(out), V.body);
});
test('random encryption round-trips through an independent decrypt', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const auth = crypto.randomBytes(16);
  const msg = JSON.stringify({ title: 'Evening Reset 🌙', body: 'עדיין גולל?' });
  const buf = encryptPayload(msg, { p256dh: b64u.enc(ua.getPublicKey()), auth: b64u.enc(auth) });
  const salt = buf.subarray(0, 16), idlen = buf[20], asPub = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ua.computeSecret(asPub), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(-16));
  const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2); assert.equal(pt.subarray(0, -1).toString(), msg);
});
test('VAPID JWT verifies with the public key', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); const jwk = privateKey.export({ format: 'jwk' });
  const pub = b64u.enc(Buffer.concat([Buffer.from([4]), b64u.dec(jwk.x), b64u.dec(jwk.y)]));
  const h = vapidHeaders('https://fcm.googleapis.com/fcm/send/abc', { publicKey: pub, privateKey: jwk.d, subject: 'mailto:a@b.c' }, 1e12);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h.Authorization); assert.ok(m); assert.equal(m[4], pub);
  assert.ok(crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, b64u.dec(m[3])));
  assert.equal(JSON.parse(b64u.dec(m[2])).aud, 'https://fcm.googleapis.com');
});
test('endpoint allow-list', () => {
  assert.ok(isAllowedEndpoint('https://fcm.googleapis.com/fcm/send/x'));
  assert.ok(isAllowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
  for (const u of ['http://fcm.googleapis.com/x', 'https://evil.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://169.254.169.254/', 'nope']) assert.ok(!isAllowedEndpoint(u), u);
});
