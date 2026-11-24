// 就活ボード API（Cloudflare Workers）
//   GET  /api/ping  … トークン確認
//   POST /api/sync  … 端末の変更を送り、ほかの端末の変更を受け取る
//   /api/coach/*    … AIコーチ（coach.js）
//   /api/push/*     … プッシュ通知（notify.js）
//   /api/ai/*       … AIタブ：アプリを操作できるAI（agent.js）
// Cron（15分ごと）… 設定時刻になったら通知を送る
// すべての /api/* はアクセストークン（Authorization: Bearer ...）が必要。

import { handleCoach, CoachError } from './coach.js';
import { handleNotify, NotifyError, runScheduled } from './notify.js';
import { handleAgent, AgentError } from './agent.js';

const COLLS = new Set(['daily', 'hours', 'weekChecks', 'companies']);
const MAX_CHANGES = 1000;
const MAX_DATA_BYTES = 4096;
const MAX_BODY_BYTES = 1_000_000;
const SYNC_OVERLAP_MS = 60_000; // 取りこぼし防止のため、前回より少し前から取り直す
const BATCH_SIZE = 50;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runScheduled(env)
        .then((r) => { if (r.sent?.length || r.note) console.log('scheduled', JSON.stringify(r)); })
        .catch((e) => console.error('scheduled failed', e)),
    );
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const cors = corsHeaders(origin, env);

    // 許可していないオリジンのブラウザからの呼び出しは拒否
    if (origin && !cors) return new Response('forbidden origin', { status: 403 });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors || {} });

    try {
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
      await requireAuth(req, env);

      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /api/ping') return json({ ok: true, now: Date.now() }, 200, cors);
      if (route === 'POST /api/sync') return json(await sync(await readJson(req), env), 200, cors);
      if (url.pathname.startsWith('/api/ai/')) {
        const body = req.method === 'POST' ? await readJson(req) : null;
        const out = await handleAgent(route, url, body, env);
        if (out) return json(out, 200, cors);
      }
      if (url.pathname.startsWith('/api/push/')) {
        const body = req.method === 'POST' ? await readJson(req) : null;
        const out = await handleNotify(route, body, env);
        if (out) return json(out, 200, cors);
      }
      if (url.pathname.startsWith('/api/coach/')) {
        const body = req.method === 'POST' ? await readJson(req) : null;
        const out = await handleCoach(route, url, body, env);
        if (out) return json(out, 200, cors);
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      if (e instanceof HttpError || e instanceof CoachError || e instanceof NotifyError || e instanceof AgentError) return json({ error: e.message }, e.status, cors);
      console.error(e);
      return json({ error: 'server error' }, 500, cors);
    }
  },
};

// ---------- CORS ----------
function corsHeaders(origin, env) {
  if (!origin) return null;
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (!allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// ---------- 認証 ----------
async function requireAuth(req, env) {
  const expected = env.ACCESS_TOKEN;
  // 設定漏れのときは誰も通さない
  if (!expected || expected.length < 32) throw new HttpError(500, 'ACCESS_TOKEN is not configured (32文字以上必要)');
  const m = /^Bearer (.+)$/.exec(req.headers.get('Authorization') || '');
  if (!m || !(await safeEqual(m[1], expected))) throw new HttpError(401, 'unauthorized');
}

async function safeEqual(a, b) {
  // 長さの違いも漏らさないよう、ハッシュしてから一定時間比較
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

// ---------- 同期 ----------
// 受け取る形： { since: number, changes: [{ c: coll, k: key, d: data(object), u: number }] }
// 返す形：     { next: number, changes: [{ c, k, d, u }] }
export async function sync(body, env) {
  const since = Number.isFinite(body?.since) ? Math.max(0, body.since) : 0;
  const changes = Array.isArray(body?.changes) ? body.changes : [];
  if (changes.length > MAX_CHANGES) throw new HttpError(413, `changes は1回 ${MAX_CHANGES} 件まで`);

  const now = Date.now();
  const stmts = changes.map((ch) => {
    const { c, k, u } = validateChange(ch);
    return env.DB.prepare(
      `INSERT INTO records (coll, key, data, u, s) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (coll, key) DO UPDATE SET data = excluded.data, u = excluded.u, s = excluded.s
       WHERE excluded.u > records.u`,
    ).bind(c, k, JSON.stringify(ch.d), u, now);
  });
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await env.DB.batch(stmts.slice(i, i + BATCH_SIZE));
  }

  const { results } = await env.DB.prepare('SELECT coll, key, data, u FROM records WHERE s >= ?1').bind(since).all();
  return {
    next: now - SYNC_OVERLAP_MS,
    changes: results.map((r) => ({ c: r.coll, k: r.key, d: JSON.parse(r.data), u: r.u })),
  };
}

function validateChange(ch) {
  if (!ch || typeof ch !== 'object') throw new HttpError(400, 'bad change');
  const { c, k, d, u } = ch;
  if (!COLLS.has(c)) throw new HttpError(400, `unknown collection: ${c}`);
  if (typeof k !== 'string' || !k || k.length > 120) throw new HttpError(400, 'bad key');
  if (!Number.isSafeInteger(u) || u <= 0) throw new HttpError(400, 'bad u');
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new HttpError(400, 'bad data');
  if (JSON.stringify(d).length > MAX_DATA_BYTES) throw new HttpError(413, 'data too large');
  return { c, k, u };
}

// ---------- 道具 ----------
async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(cors || {}) },
  });
}
