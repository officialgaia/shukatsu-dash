// Web プッシュ送信（ライブラリなし・WebCrypto のみ。Cloudflare Workers でも Node でも動く）
//   ・VAPID（RFC 8292）… ES256 の JWT で送信元を証明する
//   ・本文の暗号化（RFC 8291 / RFC 8188 aes128gcm）
//
// 使い方：
//   const res = await sendPush(subscription, JSON.stringify(payload), {
//     publicKey,  // VAPID 公開鍵（base64url、65バイトの非圧縮点）
//     privateKey, // VAPID 秘密鍵（base64url、32バイトの d）
//     subject,    // 'https://...' か 'mailto:...'
//   }, { ttl: 3600, urgency: 'normal', topic: 'morning' });
//   res.status が 404 / 410 なら、その購読は無効なので削除する。

const enc = new TextEncoder();

export function b64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// ---------- VAPID ----------
async function importVapidPrivate(publicKey, privateKey) {
  const pub = b64urlDecode(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID 公開鍵の形式が違います（65バイトの非圧縮点が必要）');
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    d: privateKey,
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

export async function vapidAuthHeader(endpoint, vapid, expSeconds = 12 * 3600) {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + expSeconds,
    sub: vapid.subject,
  })));
  const key = await importVapidPrivate(vapid.publicKey, vapid.privateKey);
  // WebCrypto の ECDSA 署名は r||s（64バイト）で、JWS の ES256 と同じ形
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

// ---------- 本文の暗号化（aes128gcm） ----------
export async function encryptPayload(subscription, payload, { salt, asKeyPair } = {}) {
  const uaPublic = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);
  if (uaPublic.length !== 65) throw new Error('p256dh の長さが違います');
  if (authSecret.length !== 16) throw new Error('auth の長さが違います');

  // 送信ごとに使い捨ての鍵ペア
  const as = asKeyPair || (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  // RFC 8291 §3.3–3.4
  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));

  // RFC 8188 §2.2–2.3
  salt = salt || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const plain = concat(typeof payload === 'string' ? enc.encode(payload) : payload, new Uint8Array([2])); // 2 = 最後のレコード
  const rs = 4096;
  if (plain.length + 16 > rs) throw new Error('通知の本文が長すぎます');
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plain));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

// ---------- 送信 ----------
export async function sendPush(subscription, payload, vapid, { ttl = 3600, urgency = 'normal', topic } = {}) {
  const body = await encryptPayload(subscription, payload);
  const headers = {
    Authorization: await vapidAuthHeader(subscription.endpoint, vapid),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
  };
  if (topic) headers.Topic = topic; // 同じ topic の未配達の通知は新しいもので置き換わる
  return fetch(subscription.endpoint, { method: 'POST', headers, body });
}
