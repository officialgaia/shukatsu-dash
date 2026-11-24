// AIタブ：アプリを操作できるAI（Claude のツール使用）
//   POST /api/ai/chat   { id?, text }  … 話しかける（id がなければ新しい会話）
//   GET  /api/ai/chats                … 会話の一覧
//   GET  /api/ai/chat?id=             … 1つの会話（画面に出す形）
//
// AI は下のツールで D1 のデータ（同期と同じ records 表）を読み書きする。
// 書いたデータは、スマホが次に同期したときに画面に反映される。
//
// 環境変数：COACH_MODEL / COACH_EFFORT（M3 と共通）
//          AI_DAILY_LIMIT（1日に送れる回数、初期値 40）
//          AI_MAX_TURNS（1つの会話で送れる回数、初期値 30）
//          COACH_MOCK=1 で Claude を呼ばずに決まった動きをする（ローカル確認用）

import Anthropic from '@anthropic-ai/sdk';
import { loadPlan } from './notify.js';
import { jstNow, addDays, mondayOf, daysBetween, md, DOW, dowOf } from './dates.js';

export class AgentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_TOOL_ROUNDS = 8; // 1回の返事の中でツールを使う回数の上限
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5-2']);
const STAGES = ['未エントリー', 'ES', '面接', '内定', '見送り'];
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

function cfg(env) {
  return {
    model: env.COACH_MODEL || 'claude-sonnet-5-5',
    effort: env.COACH_EFFORT || 'low',
    dailyLimit: Number(env.AI_DAILY_LIMIT) || 40,
    maxTurns: Number(env.AI_MAX_TURNS) || 30,
    mock: env.COACH_MOCK === '1',
  };
}

// ---------- AI への指示（固定。キャッシュされる） ----------
const SYSTEM_PROMPT = `あなたは「就活ボード」というアプリの中にいるAIアシスタントです。利用者は大学生で、東京都庁（一般方式）が第一志望、民間企業の就活も並行しています。アプリのデータを読み書きするツールを使えます。

## できること
- 勉強時間の記録（record_study_hours）
- 毎日のチェック「数的処理」「TACの講義」（set_daily_check）
- 週ごとのやることのチェック（set_week_item）
- 民間の会社の追加・変更（add_company / update_company / list_companies）
- 状況の確認（get_status / get_study_history）
- 週の振り返りの保存（save_weekly_review）

## 操作のルール
- 利用者が「やった」「記録して」「追加して」など、事実や依頼をはっきり言ったら、確認を挟まずにツールで反映する。反映したら、何をしたかを1行で伝える（例：「11/25に3時間（憲法）を記録しました」）。
- 日付を言わなければ今日のこと。「昨日」「月曜」なども今日から計算する。未来の日付には記録しない。
- 時間・会社名・どの項目かがあいまいなときだけ、短く聞き返す。推測で記録しない。
- 頼まれていないデータは変えない。会社を消す機能はない（もう追わない会社は「C」か「見送り」にする）。
- 「1社追加」などの週のやることが、話の流れで終わったと分かったら、その項目にもチェックを付けてよい（付けたら伝える）。
- 数字や状況を聞かれたら、推測せずツールで確かめてから答える。

## 相談・振り返り
- 責めない。できたことを先に認める。短く（2〜5文）、具体的に。
- 計画（勉強の順番・志望先）を勝手に大きく変える提案はしない。判断ポイントの週は材料を並べて、決めるのは本人に任せる。
- 実在する企業の選考日程や評判を推測で断定しない。会社探しは「条件検索 → 四季報・OpenWork で確認」の手順を案内する。
- 「振り返り」を頼まれたら、下の「日曜の振り返り」の3つの問いを1つずつ聞き、判定ルールで今週を一言で評価し、最後に「来週やること」を3つにまとめて save_weekly_review で保存する。
- 体調やメンタルの深刻な不調が出たら、無理に進めず休むことや大学の相談窓口を勧める。

## 書き方
- 普通の文章で。見出しや太字は使わない。箇条書きは必要なときだけ短く。`;

// ---------- ツールの定義 ----------
function toolDefs(plan) {
  const checkIds = (plan?.dailyChecks || [{ id: 'suuteki' }, { id: 'tac' }]).map((c) => c.id);
  const t = (name, description, properties) => ({
    name, description, strict: true,
    input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  });
  return [
    t('get_status', '指定した週（省略時は今週）の計画・週チェック・毎日のチェック・勉強時間を返す。', {
      week_start: nullable({ type: 'string', format: 'date', description: 'その週の月曜日（YYYY-MM-DD）。null なら今週' }),
    }),
    t('record_study_hours', 'ある日の勉強時間を記録する。mode=set はその日の合計をこの値にする、add は今の値に足す。0.5時間刻み。', {
      date: { type: 'string', format: 'date', description: 'YYYY-MM-DD（日本時間）' },
      hours: { type: 'number', description: '時間（0.5刻み）' },
      mode: { type: 'string', enum: ['set', 'add'] },
      tags: nullable({ type: 'array', items: { type: 'string' }, description: '科目タグ（例：憲法、数的処理）。null なら今のタグのまま' }),
    }),
    t('set_daily_check', '毎日のチェックを付ける／外す。', {
      date: { type: 'string', format: 'date' },
      check: { type: 'string', enum: checkIds, description: checkIds.map((id) => `${id}=${(plan?.dailyChecks || []).find((c) => c.id === id)?.label || id}`).join(', ') },
      done: { type: 'boolean' },
    }),
    t('set_week_item', '週ごとのやることのチェックを付ける／外す。item_id は get_status かデータ欄に書かれた ID。', {
      item_id: { type: 'string', description: '例：2026-11-23:minkan:0' },
      done: { type: 'boolean' },
    }),
    t('list_companies', '登録している民間の会社の一覧（ID・仕分け・選考段階・メモ）を返す。', {}),
    t('add_company', '民間の会社を追加する。同じ名前がすでにあれば追加せずにそれを返す。', {
      name: { type: 'string' },
      rank: { type: 'string', enum: ['A', 'B', 'C'], description: 'A=今〜2月に動く / B=4月下旬以降 / C=もう追わない' },
      stage: { type: 'string', enum: STAGES },
      memo: nullable({ type: 'string' }),
    }),
    t('update_company', '会社の仕分け・選考段階・メモ・名前を変える。変えない項目は null。', {
      company_id: { type: 'string' },
      rank: nullable({ type: 'string', enum: ['A', 'B', 'C'] }),
      stage: nullable({ type: 'string', enum: STAGES }),
      memo: nullable({ type: 'string' }),
      name: nullable({ type: 'string' }),
    }),
    t('get_study_history', '直近の週ごとの勉強時間の合計と目標を返す。', {
      weeks: { type: 'integer', description: '何週分（1〜12）' },
    }),
    t('save_weekly_review', '週の振り返りの結果を保存する。保存した「来週やること」はホームに表示される。', {
      week_start: { type: 'string', format: 'date', description: '振り返った週の月曜日' },
      summary: { type: 'string', description: '振り返りのまとめ（2〜4文）' },
      next_actions: { type: 'array', items: { type: 'string' }, description: '来週やること（ちょうど3つ、各20〜40字）' },
    }),
  ];
}

// ---------- ルーティング ----------
export async function handleAgent(route, url, body, env) {
  if (route === 'POST /api/ai/chat') return chat(body, env);
  if (route === 'GET /api/ai/chats') return listChats(env);
  if (route === 'GET /api/ai/chat') return getChat(url.searchParams.get('id'), env);
  return null;
}

async function listChats(env) {
  const { results } = await env.DB.prepare('SELECT id, day, updated, title, turns FROM chats ORDER BY updated DESC LIMIT 50').all();
  return { chats: results };
}

async function getChat(id, env) {
  const row = await env.DB.prepare('SELECT id, day, title, turns, display FROM chats WHERE id = ?1').bind(String(id || '')).first();
  if (!row) throw new AgentError(404, '見つかりません');
  return { id: row.id, day: row.day, title: row.title, turns: row.turns, maxTurns: cfg(env).maxTurns, display: JSON.parse(row.display) };
}

// ---------- 会話 ----------
async function chat(body, env) {
  const c = cfg(env);
  const text = String(body?.text || '').trim();
  if (!text) throw new AgentError(400, 'メッセージが空です');
  if (text.length > 2000) throw new AgentError(413, '2000文字までにしてください');
  const { day } = jstNow();

  // 使いすぎ防止（日本時間の1日あたり）
  const countKey = `ai_count:${day}`;
  const cnt = await env.DB.prepare('SELECT value FROM kv WHERE key = ?1').bind(countKey).first();
  if (cnt && Number(cnt.value) >= c.dailyLimit) throw new AgentError(429, `今日はもう ${c.dailyLimit} 回話しかけています。また明日どうぞ。`);

  const plan = (await loadPlan(env)) || (body?.plan && typeof body.plan === 'object' ? body.plan : null);

  let row = body?.id ? await env.DB.prepare('SELECT * FROM chats WHERE id = ?1').bind(String(body.id)).first() : null;
  if (body?.id && !row) throw new AgentError(404, '会話が見つかりません。新しい会話を始めてください。');
  if (row && row.turns >= c.maxTurns) throw new AgentError(409, 'この会話は長くなったので、「新しい会話」から続けてください。');

  const isNew = !row;
  const context = isNew ? await buildContext(plan, env) : row.context;
  const messages = isNew ? [] : JSON.parse(row.messages);
  const display = isNew ? [] : JSON.parse(row.display);
  const startLen = messages.length;

  messages.push({ role: 'user', content: text });
  display.push({ r: 'user', t: text });

  const ctx = { env, plan, day, actions: [], review: null };
  const tools = toolDefs(plan);
  let finalText = '';
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const res = await callClaude(c, context, messages, tools, env, round === MAX_TOOL_ROUNDS);
      messages.push({ role: 'assistant', content: res.content });
      if (res.stop_reason === 'pause_turn') continue;
      const uses = res.content.filter((b) => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !uses.length) {
        finalText = textOf(res.content);
        break;
      }
      const results = [];
      for (const u of uses) {
        let out, isError = false;
        try {
          out = await runTool(u.name, u.input || {}, ctx);
        } catch (e) {
          out = { error: e.message || String(e) };
          isError = true;
        }
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out), ...(isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (e) {
    // 途中で失敗したら、この発言は保存しない（操作済みのデータはそのまま）
    messages.length = startLen;
    if (ctx.actions.length) e.message = `${e.message}（${ctx.actions.map((a) => a.label).join('、')} は反映済みです）`;
    throw e;
  }
  if (!finalText) finalText = ctx.actions.length ? '反映しました。' : 'うまく答えられませんでした。もう一度送ってください。';

  for (const a of ctx.actions) display.push({ r: 'act', t: a.label });
  display.push({ r: 'ai', t: finalText });

  const now = Date.now();
  const title = isNew ? text.slice(0, 30) : row.title;
  const id = isNew ? crypto.randomUUID() : row.id;
  const turns = (row?.turns || 0) + 1;
  if (isNew) {
    await env.DB.prepare('INSERT INTO chats (id, day, created, updated, title, context, messages, display, turns) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8)')
      .bind(id, day, now, title, context, JSON.stringify(messages), JSON.stringify(display), turns).run();
  } else {
    const r = await env.DB.prepare('UPDATE chats SET messages = ?1, display = ?2, turns = ?3, updated = ?4 WHERE id = ?5 AND turns = ?6')
      .bind(JSON.stringify(messages), JSON.stringify(display), turns, now, id, row.turns).run();
    if (!r.meta.changes) throw new AgentError(409, 'ほかの画面で先に送られました。開き直してください。');
  }
  await env.DB.prepare("INSERT INTO kv (key, value) VALUES (?1, '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").bind(countKey).run();

  return { id, reply: finalText, actions: ctx.actions.map((a) => a.label), review: ctx.review, turns, maxTurns: c.maxTurns, changed: ctx.actions.length > 0 };
}

// ---------- Claude 呼び出し ----------
async function callClaude(c, context, messages, tools, env, lastRound) {
  if (c.mock) return mockClaude(messages, lastRound);
  if (!env.ANTHROPIC_API_KEY) throw new AgentError(500, 'ANTHROPIC_API_KEY が設定されていません');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 });
  const params = {
    model: c.model,
    max_tokens: 16000,
    output_config: { effort: c.effort },
    // 固定の指示 → 会話を始めた時点のデータ の順。ツール定義も含めて先頭がキャッシュされる
    system: [
      { type: 'text', text: SYSTEM_PROMPT },
      { type: 'text', text: context, cache_control: { type: 'ephemeral' } },
    ],
    tools,
    // 上限に達したら、ツールを使わずに答えてもらう
    ...(lastRound ? { tool_choice: { type: 'none' } } : {}),
    messages,
  };
  if (FALLBACK_MODELS.has(c.model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  let res;
  try {
    res = await client.beta.messages.create(params);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AgentError(500, 'ANTHROPIC_API_KEY が正しくありません');
    if (e instanceof Anthropic.RateLimitError) throw new AgentError(503, 'AI が混み合っています。少し待ってからもう一度送ってください。');
    if (e instanceof Anthropic.BadRequestError) {
      console.error('Claude 400', e.message);
      throw new AgentError(502, `AI への依頼に失敗しました（${e.message}）`);
    }
    if (e instanceof Anthropic.APIError) {
      console.error('Claude API error', e.status, e.message);
      throw new AgentError(502, 'AI からの返事を受け取れませんでした。もう一度送ってください。');
    }
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new AgentError(422, 'この内容には AI が答えられませんでした。言い方を変えて送ってください。');
  if (res.stop_reason === 'max_tokens') throw new AgentError(502, 'AI の返事が長すぎて途中で切れました。もう一度送ってください。');
  return res;
}

function textOf(content) {
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// ---------- データの読み書き（同期と同じ records 表） ----------
async function getRec(env, coll, key) {
  const r = await env.DB.prepare('SELECT data, u FROM records WHERE coll = ?1 AND key = ?2').bind(coll, key).first();
  return r ? { ...JSON.parse(r.data), u: r.u } : null;
}

async function putRec(env, coll, key, data) {
  const now = Date.now();
  // 端末の時計が少し進んでいても負けないよう、今ある u より必ず大きくする
  const cur = await env.DB.prepare('SELECT u FROM records WHERE coll = ?1 AND key = ?2').bind(coll, key).first();
  const u = Math.max(now, (cur?.u || 0) + 1);
  const { u: _drop, ...clean } = data;
  await env.DB.prepare(
    `INSERT INTO records (coll, key, data, u, s) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (coll, key) DO UPDATE SET data = excluded.data, u = excluded.u, s = excluded.s`,
  ).bind(coll, key, JSON.stringify(clean), u, now).run();
}

async function allCompanies(env, plan) {
  const { results } = await env.DB.prepare("SELECT key, data FROM records WHERE coll = 'companies'").all();
  const known = new Set(results.map((r) => r.key));
  const seeds = (plan?.initialCompanies || [])
    .map((x, i) => ({ id: `seed-${i + 1}`, name: x.name, rank: x.rank, stage: x.stage, memo: x.memo || '' }))
    .filter((x) => !known.has(x.id));
  return [...results.map((r) => JSON.parse(r.data)), ...seeds].filter((x) => !x.del);
}

function weekOf(plan, mon) {
  const w = plan?.weeks?.find((x) => x.start === mon);
  if (w) return w;
  // 試験後の項目はアプリと同じく、試験後の開始日を ID に使う
  if (plan?.afterExam && mon >= mondayOf(plan.afterExam.start)) return plan.afterExam;
  return null;
}

function targetOf(plan, mon) {
  const p = plan?.studyTargets?.periods?.find((x) => mon >= x.from && mon <= x.to);
  return p ? { min: p.min, max: p.max, floor: plan.studyTargets.floor?.hours } : null;
}

async function weekStatus(env, plan, mon, today) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
  const { results } = await env.DB.prepare("SELECT coll, key, data FROM records WHERE coll IN ('hours','daily') AND key >= ?1 AND key <= ?2").bind(mon, days[6]).all();
  const hours = {}, daily = {};
  for (const r of results) (r.coll === 'hours' ? hours : daily)[r.key] = JSON.parse(r.data);
  const w = weekOf(plan, mon);
  const key = w?.start || mon;
  const { results: wc } = await env.DB.prepare("SELECT key, data FROM records WHERE coll = 'weekChecks' AND key LIKE ?1").bind(`${key}:%`).all();
  const checked = new Set(wc.filter((r) => JSON.parse(r.data).v).map((r) => r.key));
  const items = [];
  for (const side of ['tocho', 'minkan', 'other']) {
    (w?.[side] || []).forEach((text, i) => items.push({ id: `${key}:${side}:${i}`, side: { tocho: '都庁', minkan: '民間', other: 'その他' }[side], text, done: checked.has(`${key}:${side}:${i}`) }));
  }
  const checks = plan?.dailyChecks || [{ id: 'suuteki', label: '数的処理' }, { id: 'tac', label: 'TACの講義' }];
  const total = Math.round(days.reduce((s, d) => s + (hours[d]?.h || 0), 0) * 10) / 10;
  return {
    week: `${mon}〜${days[6]}`,
    theme: w ? `${w.month || ''}・${w.phase || ''}` : null,
    items,
    days: days.map((d) => ({
      date: d, dow: DOW[dowOf(d)], future: d > today,
      hours: hours[d]?.h || 0, tags: hours[d]?.tags || [],
      checks: Object.fromEntries(checks.map((c) => [c.label, !!daily[d]?.[c.id]])),
    })),
    total_hours: total,
    target: targetOf(plan, mon),
  };
}

function checkDate(date, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('日付は YYYY-MM-DD で指定してください');
  if (date > today) throw new Error('未来の日付には記録できません');
  if (daysBetween(date, today) > 60) throw new Error('60日より前の日付には記録できません');
}

// ---------- ツールの実行 ----------
async function runTool(name, input, ctx) {
  const { env, plan, day } = ctx;
  const act = (label) => ctx.actions.push({ label });

  switch (name) {
    case 'get_status': {
      const mon = input.week_start ? mondayOf(input.week_start) : mondayOf(day);
      return weekStatus(env, plan, mon, day);
    }
    case 'record_study_hours': {
      checkDate(input.date, day);
      const h = Number(input.hours);
      if (!Number.isFinite(h) || h < 0 || h > 24) throw new Error('時間は0〜24で指定してください');
      const cur = (await getRec(env, 'hours', input.date)) || { h: 0, tags: [] };
      let next = Math.round((input.mode === 'add' ? (cur.h || 0) + h : h) * 2) / 2;
      next = Math.min(24, Math.max(0, next));
      const tags = Array.isArray(input.tags) ? [...new Set(input.tags.map(String))].slice(0, 10) : cur.tags || [];
      await putRec(env, 'hours', input.date, { h: next, tags });
      act(`${md(input.date)} の勉強時間を ${next}時間に${tags.length ? `（${tags.join('・')}）` : ''}`);
      return { ok: true, date: input.date, hours: next, tags };
    }
    case 'set_daily_check': {
      checkDate(input.date, day);
      const label = (plan?.dailyChecks || []).find((c) => c.id === input.check)?.label || input.check;
      const cur = (await getRec(env, 'daily', input.date)) || {};
      await putRec(env, 'daily', input.date, { ...cur, [input.check]: !!input.done });
      act(`${md(input.date)} の「${label}」を${input.done ? '完了' : '未完了'}に`);
      return { ok: true };
    }
    case 'set_week_item': {
      const m = /^(\d{4}-\d{2}-\d{2}):(tocho|minkan|other):(\d+)$/.exec(String(input.item_id));
      if (!m) throw new Error('item_id の形式が違います（例 2026-11-23:minkan:0）');
      const w = weekOf(plan, m[1]);
      const text = w?.[m[2]]?.[Number(m[3])];
      if (!text) throw new Error('その項目は計画にありません');
      await putRec(env, 'weekChecks', input.item_id, { v: !!input.done });
      act(`週のやること「${text}」を${input.done ? '完了' : '未完了'}に`);
      return { ok: true, item: text };
    }
    case 'list_companies': {
      return { companies: await allCompanies(env, plan) };
    }
    case 'add_company': {
      const name = String(input.name || '').trim();
      if (!name) throw new Error('会社名が空です');
      const list = await allCompanies(env, plan);
      const same = list.find((x) => x.name.replace(/\s/g, '') === name.replace(/\s/g, ''));
      if (same) return { ok: false, already: same, note: '同じ名前の会社がすでにあります。変えるなら update_company を使う' };
      const id = `ai-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const rec = { id, name, rank: input.rank, stage: input.stage, memo: input.memo || '' };
      await putRec(env, 'companies', id, rec);
      act(`会社「${name}」を ${input.rank}・${input.stage} で追加`);
      return { ok: true, company: rec };
    }
    case 'update_company': {
      const list = await allCompanies(env, plan);
      const cur = list.find((x) => x.id === input.company_id);
      if (!cur) throw new Error('その ID の会社はありません（list_companies で確認）');
      const next = { ...cur };
      const changes = [];
      if (input.name) { next.name = String(input.name).trim(); changes.push(`名前→${next.name}`); }
      if (input.rank) { next.rank = input.rank; changes.push(`仕分け→${input.rank}`); }
      if (input.stage) { next.stage = input.stage; changes.push(`段階→${input.stage}`); }
      if (input.memo !== null && input.memo !== undefined) { next.memo = String(input.memo); changes.push('メモを更新'); }
      if (!changes.length) return { ok: true, note: '変更なし' };
      await putRec(env, 'companies', cur.id, next);
      act(`「${cur.name}」の${changes.join('・')}`);
      return { ok: true, company: next };
    }
    case 'get_study_history': {
      const n = Math.min(12, Math.max(1, Number(input.weeks) || 4));
      const mon = mondayOf(day);
      const from = addDays(mon, -7 * (n - 1));
      const { results } = await env.DB.prepare("SELECT key, data FROM records WHERE coll = 'hours' AND key >= ?1 AND key <= ?2").bind(from, addDays(mon, 6)).all();
      const byDay = Object.fromEntries(results.map((r) => [r.key, JSON.parse(r.data).h || 0]));
      const weeks = [];
      for (let i = 0; i < n; i++) {
        const m = addDays(from, 7 * i);
        const total = Array.from({ length: 7 }, (_, k) => byDay[addDays(m, k)] || 0).reduce((a, b) => a + b, 0);
        weeks.push({ week_start: m, total_hours: Math.round(total * 10) / 10, target: targetOf(plan, m), current: m === mon });
      }
      return { weeks };
    }
    case 'save_weekly_review': {
      const mon = mondayOf(String(input.week_start));
      const next = (input.next_actions || []).map(String).filter(Boolean).slice(0, 3);
      if (next.length !== 3) throw new Error('next_actions はちょうど3つにしてください');
      const now = Date.now();
      await env.DB.prepare('INSERT INTO reviews (id, week, created, updated, context, messages, turns, summary, next, status) VALUES (?1, ?2, ?3, ?3, ?4, ?5, 0, ?6, ?7, ?8)')
        .bind(crypto.randomUUID(), mon, now, 'ai-tab', '[]', String(input.summary || ''), JSON.stringify(next), 'done').run();
      ctx.review = { week: mon, next };
      act(`${md(mon)}〜の週の振り返りを保存（来週やること3つ）`);
      return { ok: true };
    }
    default:
      throw new Error(`知らないツールです：${name}`);
  }
}

// ---------- 会話を始めた時点のデータ ----------
async function buildContext(plan, env) {
  const { day } = jstNow();
  const mon = mondayOf(day);
  const st = await weekStatus(env, plan, mon, day);
  const companies = await allCompanies(env, plan);
  const last = await env.DB.prepare("SELECT week, next FROM reviews WHERE status = 'done' ORDER BY created DESC LIMIT 1").first();
  const L = [];
  L.push('# 会話を始めた時点のデータ（変わったかもしれないので、正確な数字が必要なときはツールで確かめる）');
  L.push(`今日：${day}（${DOW[dowOf(day)]}）`);
  if (plan?.examDate) L.push(`都庁の試験日：${plan.examDate}（あと${daysBetween(day, plan.examDate)}日）`);
  L.push('', `## 今週 ${md(mon)}〜 ${st.theme || ''}`);
  for (const it of st.items) L.push(`- [${it.done ? 'x' : ' '}] ${it.side}：${it.text}（item_id: ${it.id}）`);
  L.push(`勉強時間：今週 ${st.total_hours}時間${st.target ? `（目標 ${st.target.min}〜${st.target.max}、最低 ${st.target.floor}）` : ''}`);
  for (const d of st.days.filter((x) => !x.future)) {
    L.push(`- ${md(d.date)}(${d.dow}) ${d.hours}h ${Object.entries(d.checks).map(([k, v]) => `${k}${v ? '○' : '×'}`).join(' ')}`);
  }
  const nw = weekOf(plan, addDays(mon, 7));
  if (nw) L.push('', `## 来週 ${md(addDays(mon, 7))}〜`, ...[...(nw.tocho || []).map((x) => `- 都庁：${x}`), ...(nw.minkan || []).map((x) => `- 民間：${x}`)]);
  const dec = (plan?.decisionPoints || []).filter((d) => addDays(mon, 13) >= d.from && mon <= d.to);
  if (dec.length) L.push('', '## 判断ポイント（今週・来週）', ...dec.map((d) => `- ${d.title}：${d.text}`));
  L.push('', '## 民間の会社（A=今〜2月に動く / B=4月下旬以降 / C=もう追わない）');
  for (const x of companies) L.push(`- ${x.rank} ${x.name}（${x.stage}${x.memo ? `・${x.memo.slice(0, 40)}` : ''}）id: ${x.id}`);
  if (!companies.length) L.push('（まだなし）');
  if (last?.next) L.push('', `## 前回の振り返り（${md(last.week)}〜の週）で決めた「来週やること」`, ...JSON.parse(last.next).map((x, i) => `${i + 1}. ${x}`));
  const qs = plan?.sundayRoutine || ['今週、数的処理を毎日やれたか', 'TACの講義が予定どおり進んだか', '新しい会社を1社探す（条件検索→四季報・OpenWorkで確認）'];
  L.push('', '## 日曜の振り返り（この順に1つずつ）', ...qs.map((q, i) => `${i + 1}. ${q}`));
  L.push(`判定ルール：${plan?.sundayRule || '1と2が守れていれば順調。崩れた週は、翌週の民間の予定を1つ減らして調整する。'}`);
  if (plan?.dailyBase) L.push(`毎日の土台：${plan.dailyBase}`);
  return L.join('\n');
}

// ---------- ローカル確認用：決まった動きをする偽物のモデル ----------
function mockClaude(messages, lastRound) {
  const last = messages[messages.length - 1];
  // ツールの結果が返ってきたら、まとめの返事をして終わる
  if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: '（テスト用）反映しました。' }] };
  }
  const text = String(last.content);
  const { day } = jstNow();
  const uses = [];
  const id = () => `toolu_${Math.random().toString(36).slice(2, 10)}`;
  const h = /(\d+(?:\.\d+)?)\s*時間/.exec(text);
  if (h) uses.push({ type: 'tool_use', id: id(), name: 'record_study_hours', input: { date: /昨日/.test(text) ? addDays(day, -1) : day, hours: Number(h[1]), mode: 'set', tags: /憲法/.test(text) ? ['憲法'] : null } });
  if (/数的/.test(text)) uses.push({ type: 'tool_use', id: id(), name: 'set_daily_check', input: { date: day, check: 'suuteki', done: true } });
  const co = /「(.+?)」.*追加/.exec(text);
  if (co) uses.push({ type: 'tool_use', id: id(), name: 'add_company', input: { name: co[1], rank: 'B', stage: '未エントリー', memo: null } });
  if (/未来/.test(text)) uses.push({ type: 'tool_use', id: id(), name: 'record_study_hours', input: { date: addDays(day, 3), hours: 2, mode: 'set', tags: null } });
  if (/振り返り.*保存/.test(text)) uses.push({ type: 'tool_use', id: id(), name: 'save_weekly_review', input: { week_start: mondayOf(day), summary: 'テスト', next_actions: ['朝の数的処理を7日', 'TACを2コマ', '1社探す'] } });
  if (/状況/.test(text)) uses.push({ type: 'tool_use', id: id(), name: 'get_status', input: { week_start: null } });
  if (uses.length && !lastRound) return { stop_reason: 'tool_use', content: [{ type: 'text', text: '' }, ...uses].filter((b) => b.type !== 'text' || b.text) };
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: '（テスト用）こんにちは。記録や会社の追加を頼んでください。' }] };
}
