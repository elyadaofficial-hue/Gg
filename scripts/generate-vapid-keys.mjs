// Run once:  node scripts/generate-vapid-keys.mjs
// Put the two values into Netlify -> Site configuration -> Environment variables.
import crypto from 'node:crypto';
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
console.log('VAPID_PUBLIC_KEY=' + pub);
console.log('VAPID_PRIVATE_KEY=' + jwk.d);
console.log('VAPID_SUBJECT=mailto:YOUR_EMAIL_HERE');
