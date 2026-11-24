// 「AIと振り返る」画面（M3）
import * as S from './store.js';
import * as Sync from './sync.js';
import { today, addDays, mondayOf, md, esc, targetFor, isSunday } from './util.js';

// 画面の状態（同期で全体が描き直されても消えないよう、ここに持つ）
const st = {
  loaded: false,
  loading: false,
  busy: false, // 送信中
  error: '',
  week: null,
  current: null, // { id, week, status, turns, maxTurns, messages:[{role,text,kickoff}], next }
  history: [],
  viewing: null, // 過去の振り返りを開いているとき
  draft: '',
};
let rerender = () => {};

export function setRerender(fn) {
  rerender = fn;
}

/** 振り返りボタンを出す日か（日曜、または設定で「いつでも」） */
export function reviewAvailable() {
  return isSunday(today()) || S.getSetting('reviewAnytime', false);
}

/** Worker に渡す、その週の計画の抜き出し */
function planExcerpt(plan, week) {
  const find = (mon) => {
    const w = plan.weeks.find((x) => x.start === mon);
    if (w) return w;
    if (plan.afterExam && mon >= plan.afterExam.start) return { ...plan.afterExam, start: mon };
    return null;
  };
  const next = addDays(week, 7);
  const t = targetFor(plan, week);
  return {
    examDate: plan.examDate,
    thisWeek: find(week),
    nextWeek: find(next),
    target: t ? { min: t.min, max: t.max, floor: t.floor, label: t.label } : null,
    decisions: (plan.decisionPoints || []).filter((d) => d.from <= addDays(next, 6) && d.to >= week).map(({ title, text }) => ({ title, text })),
    dailyChecks: plan.dailyChecks.map(({ id, label }) => ({ id, label })),
    sundayRoutine: plan.sundayRoutine,
    sundayRule: plan.sundayRule,
    initialCompanies: plan.initialCompanies,
  };
}

function fail(e) {
  st.error = e.message || String(e);
  st.busy = false;
  st.loading = false;
  rerender();
}

async function load(week) {
  st.loading = true;
  st.error = '';
  st.week = week;
  rerender();
  try {
    const { reviews } = await Sync.call('/api/coach/list');
    st.history = reviews;
    rememberLatest(reviews);
    const open = reviews.find((r) => r.week === week && r.status === 'open');
    st.current = open ? await Sync.call(`/api/coach/get?id=${encodeURIComponent(open.id)}`) : null;
    st.loaded = true;
    st.loading = false;
    rerender();
  } catch (e) {
    fail(e);
  }
}

function rememberLatest(reviews) {
  const done = reviews.find((r) => r.status === 'done' && r.next?.length);
  if (done) S.setSetting('lastReview', { week: done.week, next: done.next });
}

async function startReview(plan) {
  st.busy = true;
  st.error = '';
  rerender();
  try {
    const r = await Sync.call('/api/coach/start', { method: 'POST', body: { week: st.week, plan: planExcerpt(plan, st.week) } });
    st.current = {
      id: r.id, week: r.week, status: 'open', turns: r.turns, maxTurns: r.maxTurns,
      messages: [{ role: 'user', text: 'はじめる', kickoff: true }, { role: 'assistant', text: r.reply }], next: [],
    };
    st.busy = false;
    rerender();
  } catch (e) {
    fail(e);
  }
}

async function send() {
  const text = st.draft.trim();
  if (!text || st.busy || !st.current) return;
  st.busy = true;
  st.error = '';
  st.current.messages.push({ role: 'user', text });
  st.draft = '';
  rerender();
  try {
    const r = await Sync.call('/api/coach/reply', { method: 'POST', body: { id: st.current.id, text } });
    st.current.messages.push({ role: 'assistant', text: r.reply });
    st.current.turns = r.turns;
    st.current.maxTurns = r.maxTurns;
    st.busy = false;
    rerender();
  } catch (e) {
    // 送れなかった文は入力欄に戻す
    st.current.messages.pop();
    st.draft = text;
    fail(e);
  }
}

async function finishReview() {
  if (!st.current || st.busy) return;
  st.busy = true;
  st.error = '';
  rerender();
  try {
    const r = await Sync.call('/api/coach/finish', { method: 'POST', body: { id: st.current.id } });
    st.current.status = 'done';
    st.current.next = r.next;
    if (r.summary && !st.current.messages.some((m) => m.text === r.summary)) st.current.messages.push({ role: 'assistant', text: r.summary });
    S.setSetting('lastReview', { week: st.current.week, next: r.next });
    const { reviews } = await Sync.call('/api/coach/list');
    st.history = reviews;
    st.busy = false;
    rerender();
  } catch (e) {
    fail(e);
  }
}

async function openPast(id) {
  st.loading = true;
  rerender();
  try {
    st.viewing = await Sync.call(`/api/coach/get?id=${encodeURIComponent(id)}`);
    st.loading = false;
    rerender();
  } catch (e) {
    fail(e);
  }
}

// ---------- 表示 ----------
function bubbles(msgs) {
  return msgs
    .filter((m) => !m.kickoff)
    .map((m) => `<div class="bubble ${m.role === 'user' ? 'me' : 'ai'}">${esc(m.text)}</div>`)
    .join('');
}

function nextCard(next, title = '来週やること') {
  if (!next?.length) return '';
  return `<section class="card next-card"><h2>${title}</h2><ol>${next.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></section>`;
}

export function reviewView(plan) {
  const defWeek = mondayOf(today());
  if (!Sync.isConfigured()) {
    return `<h1 class="page-h">AIと振り返る</h1>
      <section class="card"><p>AIとの振り返りには、クラウド同期の設定が必要です。</p><a class="btn" href="#/settings">設定を開く</a></section>`;
  }
  if (!st.loaded && !st.loading && !st.error) setTimeout(() => load(st.week || defWeek), 0);

  // 過去の振り返りを見ているとき
  if (st.viewing) {
    const v = st.viewing;
    return `<div class="page-h-row"><h1 class="page-h">${md(v.week)}〜の振り返り</h1><button class="btn ghost" id="rvBack">戻る</button></div>
      ${nextCard(v.next)}
      <div class="chat">${bubbles(v.messages)}</div>`;
  }

  const c = st.current;
  const weekOpts = [defWeek, addDays(defWeek, -7)];
  const head = `<div class="page-h-row"><h1 class="page-h">AIと振り返る</h1></div>`;
  const err = st.error ? `<p class="err" role="alert">${esc(st.error)}</p>` : '';

  let body;
  if (st.loading && !c) {
    body = '<p class="muted">読み込み中…</p>';
  } else if (!c) {
    body = `<section class="card">
      <p>次の3つを、AIと順番に確認します（5分くらい）。</p>
      <ol class="dots">${(plan.sundayRoutine || []).map((q) => `<li>${esc(q)}</li>`).join('')}</ol>
      <p class="muted small">${esc(plan.sundayRule || '')}</p>
      <div class="seg" role="radiogroup" aria-label="振り返る週">
        ${weekOpts.map((w, i) => `<button data-rvweek="${w}" class="${st.week === w ? 'on' : ''}">${i === 0 ? '今週' : '先週'}（${md(w)}〜）</button>`).join('')}
      </div>
      <button class="btn wide" id="rvStart" ${st.busy ? 'disabled' : ''}>${st.busy ? 'データをまとめています…' : '振り返りを始める'}</button>
      <p class="muted small">今週の勉強時間・チェック・会社リストを AI に渡して振り返ります。</p>
    </section>`;
  } else {
    const done = c.status === 'done';
    const left = Math.max(0, c.maxTurns - c.turns);
    body = `<p class="muted small">${md(c.week)}〜の週${done ? '・保存済み' : `・あと${left}回送れます`}</p>
      <div class="chat" id="chat">${bubbles(c.messages)}${st.busy ? '<div class="bubble ai typing">考えています…</div>' : ''}</div>
      ${err}
      ${done ? nextCard(c.next) + '<p class="muted small center">保存しました。来週もこの画面で振り返れます。</p>' : `
      <div class="composer">
        <textarea id="rvInput" rows="2" placeholder="${left ? '返事を書く' : '上限に達しました。まとめて保存してください'}" ${st.busy || !left ? 'disabled' : ''}>${esc(st.draft)}</textarea>
        <button class="btn" id="rvSend" ${st.busy || !left ? 'disabled' : ''}>送信</button>
      </div>
      <button class="btn ghost wide" id="rvFinish" ${st.busy ? 'disabled' : ''}>まとめて保存</button>
      <p class="muted small">「まとめて保存」で「来週やること3つ」を履歴に残します。</p>`}`;
  }

  const hist = st.history.filter((r) => r.status === 'done');
  const histHtml = hist.length ? `<h3 class="month-h">これまでの振り返り</h3>
    <ul class="colist">${hist.map((r) => `<li><button data-past="${esc(r.id)}">
      <span class="co-main"><b>${md(r.week)}〜の週</b><small>${esc((r.next || []).join(' / '))}</small></span><span class="stage">見る</span></button></li>`).join('')}</ul>` : '';

  return head + (c ? '' : err) + body + histHtml;
}

export function bindReview(plan) {
  const $ = (s) => document.querySelector(s);
  $('#rvBack')?.addEventListener('click', () => { st.viewing = null; rerender(); });
  document.querySelectorAll('[data-rvweek]').forEach((b) => b.addEventListener('click', () => { st.week = b.dataset.rvweek; load(st.week); }));
  $('#rvStart')?.addEventListener('click', () => startReview(plan));
  $('#rvFinish')?.addEventListener('click', () => {
    if (confirm('ここで振り返りを終えて、「来週やること」を保存しますか？')) finishReview();
  });
  const input = $('#rvInput');
  if (input) {
    input.addEventListener('input', () => { st.draft = input.value; });
    input.addEventListener('keydown', (e) => {
      // パソコンでは Ctrl/Cmd+Enter で送信（スマホの改行と区別するため）
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
    });
  }
  $('#rvSend')?.addEventListener('click', send);
  document.querySelectorAll('[data-past]').forEach((b) => b.addEventListener('click', () => openPast(b.dataset.past)));
  const chat = $('#chat');
  if (chat) chat.lastElementChild?.scrollIntoView({ block: 'nearest' });
}

/** 画面に入るたびに最新を取り直す */
export function resetReview() {
  st.loaded = false;
  st.viewing = null;
  st.error = '';
}
