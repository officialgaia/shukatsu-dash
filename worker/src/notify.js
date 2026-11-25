// プッシュ通知
//   GET  /api/push/config       … VAPID 公開鍵・通知の設定・文面のプレビュー
//   POST /api/push/settings     … 通知の時刻とオン・オフを保存
//   POST /api/push/subscribe    … この端末の購読を登録
//   POST /api/push/unsubscribe  … この端末の購読を削除
//   POST /api/push/test         … テスト通知を送る
// Cron（15分ごと）で runScheduled() が呼ばれ、日本時間の設定時刻になったら送る。
//
// 環境変数：VAPID_PUBLIC_KEY, VAPID_SUBJECT, PLAN_URL
// secret  ：VAPID_PRIVATE_KEY

import { sendPush } from './webpush.js';
import { jstNow, addDays, mondayOf, daysBetween, md } from './dates.js';

export class NotifyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const DEFAULT_SETTINGS = {
  morning: { on: true, time: '07:00' },
  sunday: { on: true, time: '20:00' },
};
// 設定時刻を少し過ぎても送る猶予（Cron が遅れたとき用）
const CATCH_UP_MIN = 120;

export async function handleNotify(route, body, env) {
  if (route === 'GET /api/push/config') return config(env);
  if (route === 'POST /api/push/settings') return saveSettings(body, env);
  if (route === 'POST /api/push/subscribe') return subscribe(body, env);
  if (route === 'POST /api/push/unsubscribe') return unsubscribe(body, env);
  if (route === 'POST /api/push/test') return testPush(body, env);
  return null;
}

function vapid(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new NotifyError(500, 'VAPID 鍵が設定されていません（README の手順を参照）');
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || 'https://github.io' };
}

// ---------- 設定 ----------
export async function getSettings(env) {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key = 'notify'").first();
  const saved = row ? JSON.parse(row.value) : {};
  return {
    morning: { ...DEFAULT_SETTINGS.morning, ...saved.morning },
    sunday: { ...DEFAULT_SETTINGS.sunday, ...saved.sunday },
  };
}

function validTime(t) {
  return typeof t === 'string' && /^([01]\d|2[0-3]):(00|15|30|45)$/.test(t);
}

async function saveSettings(body, env) {
  const next = await getSettings(env);
  for (const k of ['morning', 'sunday']) {
    const v = body?.[k];
    if (!v) continue;
    if (typeof v.on === 'boolean') next[k].on = v.on;
    if (v.time !== undefined) {
      if (!validTime(v.time)) throw new NotifyError(400, '時刻は15分刻み（例 07:00, 07:15）で指定してください');
      next[k].time = v.time;
    }
  }
  await env.DB.prepare("INSERT INTO kv (key, value) VALUES ('notify', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(next)).run();
  return { settings: next };
}

async function config(env) {
  const settings = await getSettings(env);
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs').first();
  const plan = await loadPlan(env);
  const day = jstNow().day;
  return {
    publicKey: env.VAPID_PUBLIC_KEY || null,
    settings,
    devices: n,
    planLoaded: !!plan,
    preview: { morning: morningMessage(plan, day, await eventsOn(env, day)), sunday: sundayMessage(plan, day) },
  };
}

// ---------- 購読 ----------
async function subscribe(body, env) {
  const s = body?.subscription;
  const ok = s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000
    && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string';
  if (!ok) throw new NotifyError(400, '購読情報の形式が違います');
  await env.DB.prepare(
    `INSERT INTO push_subs (endpoint, p256dh, auth, ua, created, fails) VALUES (?1, ?2, ?3, ?4, ?5, 0)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, fails = 0`,
  ).bind(s.endpoint, s.keys.p256dh, s.keys.auth, String(body.ua || '').slice(0, 200), Date.now()).run();
  return { ok: true };
}

async function unsubscribe(body, env) {
  await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?1').bind(String(body?.endpoint || '')).run();
  return { ok: true };
}

async function testPush(body, env) {
  const v = vapid(env);
  const where = body?.endpoint ? ' WHERE endpoint = ?1' : '';
  const stmt = env.DB.prepare(`SELECT * FROM push_subs${where}`);
  const { results } = await (body?.endpoint ? stmt.bind(String(body.endpoint)) : stmt).all();
  if (!results.length) throw new NotifyError(404, 'この端末は通知に登録されていません');
  const plan = await loadPlan(env);
  const today = jstNow().day;
  const msg = morningMessage(plan, today, await eventsOn(env, today));
  const out = await sendToAll(results, { ...msg, title: `【テスト】${msg.title}`, tag: 'test' }, v, env, { ttl: 600 });
  return out;
}

// ---------- 送信 ----------
async function sendToAll(subs, payload, v, env, opts) {
  let sent = 0, removed = 0, failed = 0;
  const errors = [];
  await Promise.all(subs.map(async (s) => {
    try {
      const res = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), v, opts);
      if (res.status === 404 || res.status === 410) {
        // 端末側で購読が切れている
        await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?1').bind(s.endpoint).run();
        removed++;
      } else if (res.ok) {
        await env.DB.prepare('UPDATE push_subs SET last_ok = ?1, fails = 0 WHERE endpoint = ?2').bind(Date.now(), s.endpoint).run();
        sent++;
      } else {
        const text = (await res.text()).slice(0, 200);
        console.error('push failed', res.status, text);
        errors.push(`${res.status} ${text}`);
        await env.DB.prepare('UPDATE push_subs SET fails = fails + 1 WHERE endpoint = ?1').bind(s.endpoint).run();
        failed++;
      }
    } catch (e) {
      console.error('push error', e);
      errors.push(String(e.message || e));
      failed++;
    }
  }));
  return { sent, removed, failed, errors };
}

/** Cron から呼ばれる。now はテスト用に差し替えられる */
export async function runScheduled(env, now = Date.now()) {
  const { day, minutes, dow } = jstNow(now);
  const settings = await getSettings(env);
  const due = [];
  for (const kind of ['morning', 'sunday']) {
    const s = settings[kind];
    if (!s.on) continue;
    if (kind === 'sunday' && dow !== 0) continue;
    const [h, m] = s.time.split(':').map(Number);
    const at = h * 60 + m;
    if (minutes < at || minutes >= at + CATCH_UP_MIN) continue;
    due.push(kind);
  }
  if (!due.length) return { day, minutes, sent: [] };

  const { results: subs } = await env.DB.prepare('SELECT * FROM push_subs').all();
  if (!subs.length) return { day, minutes, sent: [], note: 'no subscribers' };
  const v = vapid(env);
  const plan = await loadPlan(env);
  const done = [];
  for (const kind of due) {
    // 先に記録を入れ、入れられたとき（＝まだ送っていない）だけ送る
    const r = await env.DB.prepare('INSERT OR IGNORE INTO notify_log (kind, day, sent_at) VALUES (?1, ?2, ?3)').bind(kind, day, now).run();
    if (!r.meta.changes) continue;
    const msg = kind === 'morning' ? morningMessage(plan, day, await eventsOn(env, day)) : sundayMessage(plan, day);
    // 朝の通知はその日のうちだけ意味があるので、届かなければ3時間で捨てる
    const result = await sendToAll(subs, { ...msg, tag: kind }, v, env, { ttl: kind === 'morning' ? 3 * 3600 : 2 * 3600, topic: kind });
    done.push({ kind, ...result });
  }
  // 古い記録を掃除
  await env.DB.prepare('DELETE FROM notify_log WHERE day < ?1').bind(addDays(day, -30)).run();
  return { day, minutes, sent: done };
}

// ---------- 文面 ----------
export async function loadPlan(env) {
  if (!env.PLAN_URL || /YOUR-GITHUB-USERNAME/.test(env.PLAN_URL)) return null;
  try {
    const res = await fetch(env.PLAN_URL, { cf: { cacheTtl: 600, cacheEverything: true } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('plan fetch failed', e);
    return null;
  }
}

function weekOf(plan, day) {
  if (!plan?.weeks?.length) return null;
  const mon = mondayOf(day);
  const w = plan.weeks.find((x) => x.start === mon);
  if (w) return w;
  if (plan.afterExam && day >= plan.afterExam.start) return plan.afterExam;
  if (day < plan.weeks[0].start) return plan.weeks[0];
  return null;
}

function decisionsOf(plan, day) {
  return (plan?.decisionPoints || []).filter((d) => day >= d.from && day <= d.to);
}

function titleFor(plan, day) {
  if (!plan?.examDate) return '就活ボード';
  const left = daysBetween(day, plan.examDate);
  if (left > 0) return `都庁まであと${left}日`;
  if (left === 0) return '今日が本番。体調第一で';
  return '就活ボード';
}

/** その日の予定（時刻順） */
export async function eventsOn(env, day) {
  const { results } = await env.DB.prepare("SELECT data FROM records WHERE coll = 'events'").all();
  return results.map((r) => JSON.parse(r.data)).filter((e) => !e.del && e.date === day)
    .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
}

export function morningMessage(plan, day, events = []) {
  const w = weekOf(plan, day);
  const lines = decisionsOf(plan, day).map((d) => `【${d.title}】${d.text}`);
  if (events.length) lines.push(`今日の予定：${events.map((e) => `${e.time ? `${e.time} ` : ''}${e.title}`).join('、')}`);
  if (w) {
    const tocho = (w.tocho || []).join('・');
    const minkan = (w.minkan || []).join('・');
    const theme = [tocho && `今週：${tocho}`, minkan && `民間：${minkan}`].filter(Boolean).join('／');
    lines.push(`${theme || '今週のテーマを確認'}。今日も数的処理から`);
  } else {
    lines.push('今日も数的処理から');
  }
  return { title: titleFor(plan, day), body: lines.join('\n'), url: './#/home' };
}

export function sundayMessage(plan, day) {
  const lines = ['日曜の振り返りの時間です。5分で、数的処理・TAC・会社探しを確認しましょう'];
  // 来週（翌日から）の判断ポイントがあれば添える
  for (const d of decisionsOf(plan, addDays(day, 1))) lines.push(`来週は【${d.title}】${d.text}`);
  const w = weekOf(plan, addDays(day, 1));
  if (w && w.start) lines.push(`来週（${md(w.start)}〜）：${[...(w.tocho || []), ...(w.minkan || [])].join('・')}`);
  return { title: 'AIと振り返る', body: lines.join('\n'), url: './#/ai/review' };
}
