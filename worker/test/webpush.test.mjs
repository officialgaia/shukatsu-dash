// Web プッシュ実装の確認：
//  1) 暗号化した本文を、web-push ライブラリが使う参照実装（http_ece）で復号できるか
//  2) VAPID の JWT 署名が公開鍵で検証できるか
// 実行：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ece from 'http_ece';
import { encryptPayload, vapidAuthHeader, b64urlEncode } from '../src/webpush.js';

function makeSubscriber() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      keys: { p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(auth) },
    },
  };
}

test('aes128gcm で暗号化した本文を参照実装で復号できる', async () => {
  for (const text of ['hi', '今週：判断推理・憲法／民間：1社追加。今日も数的処理から', 'x'.repeat(3000)]) {
    const { ecdh, auth, subscription } = makeSubscriber();
    const body = await encryptPayload(subscription, JSON.stringify({ body: text }));
    const plain = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ecdh, authSecret: auth });
    assert.equal(JSON.parse(plain.toString('utf8')).body, text);
  }
});

test('VAPID の JWT が正しく署名され、aud/sub/exp が入っている', async () => {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = kp.privateKey.export({ format: 'jwk' });
  const pubRaw = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-65);
  const vapid = { publicKey: b64urlEncode(pubRaw), privateKey: jwk.d, subject: 'https://example.github.io' };

  const h = await vapidAuthHeader('https://fcm.googleapis.com/fcm/send/abc', vapid);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  assert.ok(m, h);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'https://example.github.io');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
  assert.equal(m[4], vapid.publicKey);
  const ok = crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: kp.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
  assert.ok(ok, '署名が検証できない');
});
