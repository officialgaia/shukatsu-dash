// VAPID 鍵ペアを作る（1回だけ実行）。
//   node scripts/vapid-keys.mjs
// 表示された PUBLIC は wrangler.toml の VAPID_PUBLIC_KEY に、
// PRIVATE は `npx wrangler secret put VAPID_PRIVATE_KEY` で secret に登録する（リポジトリに入れない）。
import { webcrypto as crypto } from 'node:crypto';

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const raw = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
const b64url = (b) => Buffer.from(b).toString('base64url');

console.log('PUBLIC  (wrangler.toml の VAPID_PUBLIC_KEY へ):');
console.log(b64url(raw));
console.log('');
console.log('PRIVATE (npx wrangler secret put VAPID_PRIVATE_KEY で登録。人に見せない):');
console.log(jwk.d);
