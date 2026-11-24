// AIコーチ（日曜の振り返り）
//   POST /api/coach/start   { week, plan }  … 今週のデータをまとめて会話を始める
//   POST /api/coach/reply   { id, text }    … 返事を送る
//   POST /api/coach/finish  { id }          … 「来週やること3つ」を保存して終える
//   GET  /api/coach/list                    … 履歴
//   GET  /api/coach/get?id=                 … 1回分の会話
//
// 環境変数（wrangler.toml の [vars]）
//   COACH_MODEL        … 使うモデル（初期値 claude-sonnet-5-5）
//   COACH_EFFORT       … low | medium | high（初期値 low。会話なので軽め）
//   COACH_MAX_TURNS    … 1回の振り返りで送れる回数の上限（初期値 10）
//   COACH_DAILY_LIMIT  … 1日に始められる振り返りの回数（初期値 3）
//   COACH_MOCK         … "1" にすると Claude を呼ばずに決まった返事を返す（ローカル確認用）
// secret
//   ANTHROPIC_API_KEY

import Anthropic from '@anthropic-ai/sdk';
import { DOW, fmt, addDays, dowOf, daysBetween, md, jstDayStartMs } from './dates.js';

export class CoachError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const KICKOFF = '日曜の振り返りを始めます。';
const NEXT_HEADING = '【来週やること】';

// サーバー側フォールバック（拒否されたときに別モデルで続ける）を使えるモデル
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5-2']);
// 会話の途中に system メッセージを入れられるモデル
const MIDSYSTEM_MODELS = new Set([
  'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8',
  'claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-haiku-5-5',
]);

const SYSTEM_PROMPT = `あなたは、就職活動中の大学生の「日曜の振り返り」に付き合うコーチです。本人は東京都庁（一般方式）が第一志望で、民間企業の就活も並行しています。毎週日曜に、この会話で1週間を振り返ります。

## 進め方
- 下の「振り返りの問い」を、書かれている順に1つずつ聞いてください。一度に2つ以上聞かないでください。
- 「今週のデータ」に書いてあることは、先に数字で伝えてから確かめてください（例：「数的処理は7日中5日チェックが付いています。抜けた2日はどんな日でしたか？」）。データにないことは推測で決めつけないでください。
- 判定ルールに従って、今週が順調だったかを一言で伝えてください。崩れた週は、来週の民間の予定を1つ減らす方向で一緒に調整します。
- 会社探しの問いでは、手順（条件検索 → 四季報・OpenWork で確認）を案内し、候補を挙げるのは本人に任せてください。実在する企業の選考日程や評判を推測で断定しないでください。
- 判断ポイントの週は、その判断のための材料（データ・本人の手応え）を並べて整理し、決めるのは本人に任せてください。

## 話し方
- 責めない。できたことを先に認める。
- 短く。1回の返答は2〜5文程度。必要なら短い箇条書き。
- 具体的に。「頑張りましょう」より「火曜と木曜の朝に数的処理30分」のように。
- 計画（勉強の順番や志望先）そのものを勝手に大きく変える提案はしない。

## 終わり方
3つの問いが終わったら（または本人が終わりたいと言ったら）、最後に必ず次の形式でまとめてください。各項目は20〜40字程度です。
${NEXT_HEADING}
1. …
2. …
3. …

体調やメンタルの深刻な不調が話に出たときは、振り返りを無理に進めず、休むことや大学の相談窓口などに相談することを勧めてください。`;

// ---------- ルーティング ----------
export async function handleCoach(route, url, body, env) {
  if (route === 'POST /api/coach/start') return start(body, env);
  if (route === 'POST /api/coach/reply') return reply(body, env);
  if (route === 'POST /api/coach/finish') return finish(body, env);
  if (route === 'GET /api/coach/list') return list(env);
  if (route === 'GET /api/coach/get') return get(url.searchParams.get('id'), env);
  return null;
}

function cfg(env) {
  return {
    model: env.COACH_MODEL || 'claude-sonnet-5-5',
    effort: env.COACH_EFFORT || 'low',
    maxTurns: Number(env.COACH_MAX_TURNS) || 10,
    dailyLimit: Number(env.COACH_DAILY_LIMIT) || 3,
    mock: env.COACH_MOCK === '1',
  };
}

// ---------- 開始 ----------
async function start(body, env) {
  const c = cfg(env);
  const week = String(body?.week || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || dowOf(week) !== 1) throw new CoachError(400, 'week は月曜日の日付で指定してください');
  const plan = body?.plan && typeof body.plan === 'object' ? body.plan : {};
  if (JSON.stringify(plan).length > 20000) throw new CoachError(413, 'plan が大きすぎます');

  // 使いすぎ防止：日本時間の今日に始めた回数
  const dayStart = jstDayStartMs(Date.now());
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM reviews WHERE created >= ?1').bind(dayStart).first();
  if (n >= c.dailyLimit) throw new CoachError(429, `今日はもう ${c.dailyLimit} 回始めています。また明日どうぞ。`);

  const context = await buildContext(week, plan, env);
  const messages = [{ role: 'user', content: KICKOFF }];
  const res = await callClaude(c, context, messages, env);
  messages.push({ role: 'assistant', content: res.content });

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO reviews (id, week, created, updated, context, messages, turns, status) VALUES (?1, ?2, ?3, ?3, ?4, ?5, 0, ?6)',
  ).bind(id, week, now, context, JSON.stringify(messages), 'open').run();

  return { id, week, reply: textOf(res.content), turns: 0, maxTurns: c.maxTurns };
}

// ---------- 返事 ----------
async function reply(body, env) {
  const c = cfg(env);
  const text = String(body?.text || '').trim();
  if (!text) throw new CoachError(400, '返事が空です');
  if (text.length > 2000) throw new CoachError(413, '返事は2000文字までにしてください');

  const row = await loadOpen(body?.id, env);
  if (row.turns >= c.maxTurns) throw new CoachError(409, '往復の上限に達しました。「まとめて保存」を押してください。');

  const messages = JSON.parse(row.messages);
  const turns = row.turns + 1;
  messages.push({ role: 'user', content: text });
  if (turns >= c.maxTurns) {
    pushInstruction(c, messages, `往復の上限に達しました。この返答で振り返りを終え、必ず「${NEXT_HEADING}」の形式でまとめてください。`);
  }

  const res = await callClaude(c, row.context, messages, env);
  messages.push({ role: 'assistant', content: res.content });

  // 同時に2回送られたときに上書きしないよう、turns が変わっていないときだけ保存
  const r = await env.DB.prepare('UPDATE reviews SET messages = ?1, turns = ?2, updated = ?3 WHERE id = ?4 AND turns = ?5 AND status = ?6')
    .bind(JSON.stringify(messages), turns, Date.now(), row.id, row.turns, 'open').run();
  if (!r.meta.changes) throw new CoachError(409, 'ほかの画面で先に送られました。開き直してください。');

  const replyText = textOf(res.content);
  return { id: row.id, reply: replyText, turns, maxTurns: c.maxTurns, hasSummary: replyText.includes(NEXT_HEADING) };
}

// ---------- 終える ----------
async function finish(body, env) {
  const c = cfg(env);
  const row = await loadOpen(body?.id, env);
  const messages = JSON.parse(row.messages);

  let summary = lastAssistantText(messages);
  if (!summary.includes(NEXT_HEADING)) {
    // まだまとめが出ていなければ、1回だけまとめを頼む（往復の上限には数えない）
    messages.push({ role: 'user', content: `ここまでの内容で、${NEXT_HEADING}の形式でまとめてください。` });
    const res = await callClaude(c, row.context, messages, env);
    messages.push({ role: 'assistant', content: res.content });
    summary = textOf(res.content);
  }
  const next = parseNext(summary);

  await env.DB.prepare('UPDATE reviews SET messages = ?1, summary = ?2, next = ?3, status = ?4, updated = ?5 WHERE id = ?6')
    .bind(JSON.stringify(messages), summary, JSON.stringify(next), 'done', Date.now(), row.id).run();
  return { id: row.id, summary, next };
}

// ---------- 履歴 ----------
async function list(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, week, created, updated, turns, status, next FROM reviews ORDER BY created DESC LIMIT 60',
  ).all();
  return { reviews: results.map((r) => ({ ...r, next: r.next ? JSON.parse(r.next) : [] })), maxTurns: cfg(env).maxTurns };
}

async function get(id, env) {
  const row = await env.DB.prepare('SELECT * FROM reviews WHERE id = ?1').bind(String(id || '')).first();
  if (!row) throw new CoachError(404, '見つかりません');
  const msgs = JSON.parse(row.messages)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m, i) => ({ role: m.role, text: typeof m.content === 'string' ? m.content : textOf(m.content), kickoff: i === 0 }))
    .filter((m) => m.text);
  return {
    id: row.id, week: row.week, status: row.status, turns: row.turns, maxTurns: cfg(env).maxTurns,
    created: row.created, messages: msgs, summary: row.summary, next: row.next ? JSON.parse(row.next) : [],
  };
}

async function loadOpen(id, env) {
  const row = await env.DB.prepare('SELECT * FROM reviews WHERE id = ?1').bind(String(id || '')).first();
  if (!row) throw new CoachError(404, '見つかりません');
  if (row.status !== 'open') throw new CoachError(409, 'この振り返りはもう保存されています');
  return row;
}

// ---------- Claude 呼び出し ----------
function pushInstruction(c, messages, text) {
  if (MIDSYSTEM_MODELS.has(c.model)) messages.push({ role: 'system', content: text });
  else {
    const last = messages[messages.length - 1];
    last.content = `${last.content}\n\n（システムからの指示：${text}）`;
  }
}

async function callClaude(c, context, messages, env) {
  if (c.mock) return mockReply(messages);
  if (!env.ANTHROPIC_API_KEY) throw new CoachError(500, 'ANTHROPIC_API_KEY が設定されていません');

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 });
  const params = {
    model: c.model,
    max_tokens: 16000,
    output_config: { effort: c.effort },
    // 固定の指示 → この振り返りで固定のデータ の順に置き、2回目以降はキャッシュを効かせる
    system: [
      { type: 'text', text: SYSTEM_PROMPT },
      { type: 'text', text: context, cache_control: { type: 'ephemeral' } },
    ],
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
    if (e instanceof Anthropic.AuthenticationError) throw new CoachError(500, 'ANTHROPIC_API_KEY が正しくありません');
    if (e instanceof Anthropic.RateLimitError) throw new CoachError(503, 'AI が混み合っています。少し待ってからもう一度送ってください。');
    if (e instanceof Anthropic.BadRequestError) {
      console.error('Claude 400', e.message);
      throw new CoachError(502, `AI への依頼に失敗しました（${e.message}）`);
    }
    if (e instanceof Anthropic.APIError) {
      console.error('Claude API error', e.status, e.message);
      throw new CoachError(502, 'AI からの返事を受け取れませんでした。もう一度送ってください。');
    }
    throw e;
  }

  if (res.stop_reason === 'refusal') {
    throw new CoachError(422, 'この内容には AI が答えられませんでした。言い方を変えて送ってください。');
  }
  if (!textOf(res.content)) throw new CoachError(502, 'AI の返事が空でした。もう一度送ってください。');
  return res;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return textOf(messages[i].content);
  }
  return '';
}

export function parseNext(text) {
  const at = text.lastIndexOf(NEXT_HEADING);
  const tail = at >= 0 ? text.slice(at + NEXT_HEADING.length) : text;
  const items = [];
  for (const line of tail.split('\n')) {
    const m = /^\s*(?:[1-3１-３][.．)）、]|[-・*•])\s*(.+?)\s*$/.exec(line);
    if (m) items.push(m[1].replace(/\*\*/g, ''));
    if (items.length === 3) break;
  }
  return items;
}

// ---------- 今週のデータをまとめる ----------
async function buildContext(week, plan, env) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const from3 = addDays(week, -21);
  const end = days[6];

  const [{ results: dayRows }, { results: checkRows }, { results: coRows }, last] = await Promise.all([
    env.DB.prepare("SELECT coll, key, data FROM records WHERE coll IN ('hours','daily') AND key >= ?1 AND key <= ?2").bind(from3, end).all(),
    env.DB.prepare("SELECT key, data FROM records WHERE coll = 'weekChecks' AND key LIKE ?1").bind(`${week}:%`).all(),
    env.DB.prepare("SELECT key, data FROM records WHERE coll = 'companies'").all(),
    env.DB.prepare("SELECT week, next FROM reviews WHERE status = 'done' AND week < ?1 ORDER BY week DESC, created DESC LIMIT 1").bind(week).first(),
  ]);

  const hours = {}, daily = {};
  for (const r of dayRows) (r.coll === 'hours' ? hours : daily)[r.key] = JSON.parse(r.data);
  const checked = new Set(checkRows.filter((r) => JSON.parse(r.data).v).map((r) => r.key));
  // 一度も編集していない初期の会社（seed-N）は端末にしかないので、plan の初期データで補う
  const known = new Set(coRows.map((r) => r.key));
  const seeds = (Array.isArray(plan.initialCompanies) ? plan.initialCompanies : [])
    .map((x, i) => ({ id: `seed-${i + 1}`, name: String(x.name || ''), rank: x.rank, stage: x.stage, memo: x.memo || '' }))
    .filter((x) => x.name && !known.has(x.id));
  const companies = [...coRows.map((r) => JSON.parse(r.data)), ...seeds].filter((x) => !x.del);
  const todayJst = fmt(jstDayStartMs(Date.now()) + 9 * 3600000);

  const L = [];
  const tw = plan.thisWeek || {};
  L.push('# 今週のデータ（アプリの記録から自動で集計）');
  L.push(`振り返る週：${md(week)}(月)〜${md(end)}(日)${tw.month ? `　時期：${tw.month}・${tw.phase || ''}` : ''}`);
  if (plan.examDate) L.push(`都庁の試験日：${plan.examDate}（この週の日曜から あと${daysBetween(end, plan.examDate)}日）`);

  L.push('', '## 今週やること（計画）と週チェック');
  for (const [side, label] of [['tocho', '都庁'], ['minkan', '民間'], ['other', 'その他']]) {
    (tw[side] || []).forEach((t, i) => L.push(`- [${checked.has(`${week}:${side}:${i}`) ? 'x' : ' '}] ${label}：${t}`));
  }
  if (!tw.tocho && !tw.minkan) L.push('（この週の計画は登録されていません）');

  L.push('', '## 毎日のチェック');
  const checks = Array.isArray(plan.dailyChecks) && plan.dailyChecks.length ? plan.dailyChecks : [{ id: 'suuteki', label: '数的処理' }, { id: 'tac', label: 'TACの講義' }];
  for (const d of days) {
    const v = daily[d] || {};
    if (d > todayJst) { L.push(`- ${md(d)}(${DOW[dowOf(d)]})：（まだ来ていない日）`); continue; }
    L.push(`- ${md(d)}(${DOW[dowOf(d)]})：${checks.map((c) => `${c.label} ${v[c.id] ? '○' : '×'}`).join('　')}`);
  }
  const past = days.filter((d) => d <= todayJst).length;
  for (const c of checks) L.push(`${c.label}：${past}日中 ${days.filter((d) => d <= todayJst && daily[d]?.[c.id]).length}日`);

  L.push('', '## 勉強時間');
  const total = sum(days.map((d) => hours[d]?.h || 0));
  const t = plan.target;
  L.push(`今週の合計：${total}時間${t ? `（目標 週${t.min}〜${t.max}時間、最低ライン ${t.floor}時間）` : '（この時期の目標は未設定）'}`);
  if (past < 7) L.push(`（${md(todayJst)}時点。週の途中のため、残りの日はまだ記録がありません）`);
  L.push(`日別：${days.filter((d) => d <= todayJst).map((d) => `${md(d)} ${hours[d]?.h || 0}h${hours[d]?.tags?.length ? `（${hours[d].tags.join('・')}）` : ''}`).join(' / ')}`);
  const prev = [3, 2, 1].map((k) => {
    const m = addDays(week, -7 * k);
    return `${md(m)}〜 ${sum(Array.from({ length: 7 }, (_, i) => hours[addDays(m, i)]?.h || 0))}h`;
  });
  L.push(`前の3週：${prev.join(' / ')}`);

  L.push('', '## 民間の会社（A=今〜2月に動く / B=4月下旬以降 / C=もう追わない）');
  if (!companies.length) L.push('（登録なし）');
  for (const r of ['A', 'B', 'C']) {
    const cs = companies.filter((x) => x.rank === r);
    if (cs.length) L.push(`${r}：${cs.map((x) => `${x.name}（${x.stage}${x.memo ? `・${x.memo.slice(0, 40)}` : ''}）`).join('、')}`);
  }
  L.push(`内定：${companies.filter((x) => x.stage === '内定').length}社　追っている社（C・見送り以外）：${companies.filter((x) => x.rank !== 'C' && x.stage !== '見送り').length}社`);

  const nw = plan.nextWeek;
  L.push('', '## 来週やること（計画）');
  if (nw) {
    L.push(`${md(nw.start)}〜（${nw.month || ''}・${nw.phase || ''}）`);
    for (const [side, label] of [['tocho', '都庁'], ['minkan', '民間'], ['other', 'その他']]) (nw[side] || []).forEach((x) => L.push(`- ${label}：${x}`));
  } else L.push('（登録なし）');

  if (Array.isArray(plan.decisions) && plan.decisions.length) {
    L.push('', '## 判断ポイント（今週・来週に該当）');
    for (const d of plan.decisions) L.push(`- ${d.title || ''}：${d.text || ''}`);
  }

  if (last?.next) {
    const n = JSON.parse(last.next);
    if (n.length) L.push('', `## 前回（${md(last.week)}〜の週）の振り返りで決めた「来週やること」`, ...n.map((x, i) => `${i + 1}. ${x}`));
  }

  L.push('', '# 振り返りの問い（この順に1つずつ）');
  const qs = Array.isArray(plan.sundayRoutine) && plan.sundayRoutine.length ? plan.sundayRoutine
    : ['今週、数的処理を毎日やれたか', 'TACの講義が予定どおり進んだか', '新しい会社を1社探す（条件検索→四季報・OpenWorkで確認）'];
  qs.forEach((q, i) => L.push(`${i + 1}. ${q}`));
  L.push(`判定ルール：${plan.sundayRule || '1と2が守れていれば順調。崩れた週は、翌週の民間の予定を1つ減らして調整する。'}`);

  return L.join('\n');
}

// ---------- ローカル確認用の決まった返事 ----------
function mockReply(messages) {
  const n = messages.filter((m) => m.role === 'user').length;
  const wrapUp = messages.some((m) => m.role === 'system') || /まとめ/.test(String(messages[messages.length - 1].content));
  const lines = [
    '（テスト用の返事）お疲れさまです。まず1つ目：今週、数的処理は毎日やれましたか？',
    '（テスト用）ありがとうございます。2つ目：TACの講義は予定どおり進みましたか？',
    '（テスト用）了解です。3つ目：新しい会社を1社探しましょう。条件検索で気になった会社はありますか？',
  ];
  const text = wrapUp || n > 3
    ? `（テスト用）今週もお疲れさまでした。\n${NEXT_HEADING}\n1. 朝の数的処理を7日続ける\n2. TACの講義を2コマ進める\n3. 条件検索で1社見つけてOpenWorkで確認`
    : lines[n - 1];
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
}

function sum(a) {
  return Math.round(a.reduce((x, y) => x + y, 0) * 10) / 10;
}
