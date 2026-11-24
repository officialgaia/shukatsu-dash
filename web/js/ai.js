// AIタブ：話しかけるだけで記録・チェック・会社の管理・振り返りができる
import * as S from './store.js';
import * as Sync from './sync.js';
import { esc, today } from './util.js';

const SUGGESTIONS = [
  '今日は3時間勉強した（憲法）',
  '数的処理おわった',
  '今週の進み具合は？',
  '週の振り返りをしたい',
  '会社を追加したい',
];

// 画面の状態（同期で全体が描き直されても消えないよう、ここに持つ）
const st = {
  loaded: false,
  loading: false,
  busy: false,
  error: '',
  draft: '',
  chatId: null,
  display: [], // [{r:'user'|'ai'|'act', t}]
  view: 'chat', // 'chat' | 'history'
  history: [],
  autoSend: null,
};
let rerender = () => {};

export function setAiRerender(fn) {
  rerender = fn;
}

/** タブに入ったとき。sub が 'review' なら振り返りを始める */
export function enterAi(sub) {
  st.view = 'chat';
  st.error = '';
  if (sub === 'review') st.autoSend = '週の振り返りをしたい';
  if (!st.loaded && !st.loading) load();
  else if (st.loaded && st.autoSend) {
    const t = st.autoSend;
    st.autoSend = null;
    setTimeout(() => send(t), 0);
  }
}

async function load() {
  st.loading = true;
  const saved = S.getSetting('aiChat', null);
  try {
    // 会話は1日1つ。日付が変わったら新しい会話にする
    if (saved?.id && saved.day === today() && Sync.isConfigured()) {
      const c = await Sync.call(`/api/ai/chat?id=${encodeURIComponent(saved.id)}`);
      st.chatId = c.id;
      st.display = c.display;
    }
  } catch {
    st.chatId = null;
    st.display = [];
  }
  st.loaded = true;
  st.loading = false;
  rerender();
  if (st.autoSend) {
    const t = st.autoSend;
    st.autoSend = null;
    send(t);
  }
}

async function send(text) {
  text = String(text || '').trim();
  if (!text || st.busy) return;
  st.busy = true;
  st.error = '';
  st.display.push({ r: 'user', t: text });
  st.draft = '';
  rerender();
  try {
    // 端末の未送信の記録を先に送っておく（AI が最新のデータを見られるように）
    await Sync.syncNow().catch(() => {});
    const r = await Sync.call('/api/ai/chat', { method: 'POST', body: { id: st.chatId, text } });
    st.chatId = r.id;
    S.setSetting('aiChat', { id: r.id, day: today() });
    for (const a of r.actions || []) st.display.push({ r: 'act', t: a });
    st.display.push({ r: 'ai', t: r.reply });
    if (r.review) S.setSetting('lastReview', r.review);
    st.busy = false;
    rerender();
    // AI が書き換えたデータを取り込む
    if (r.changed) Sync.syncNow().catch(() => {});
  } catch (e) {
    st.display.pop();
    st.draft = text;
    st.error = e.message || String(e);
    st.busy = false;
    rerender();
  }
}

function newChat() {
  st.chatId = null;
  st.display = [];
  st.error = '';
  st.view = 'chat';
  S.setSetting('aiChat', null);
  rerender();
}

async function openHistory() {
  st.view = 'history';
  st.error = '';
  rerender();
  try {
    st.history = (await Sync.call('/api/ai/chats')).chats;
  } catch (e) {
    st.error = e.message;
  }
  rerender();
}

async function openChat(id) {
  try {
    const c = await Sync.call(`/api/ai/chat?id=${encodeURIComponent(id)}`);
    st.chatId = c.id;
    st.display = c.display;
    st.view = 'chat';
    S.setSetting('aiChat', { id: c.id, day: today() });
  } catch (e) {
    st.error = e.message;
  }
  rerender();
}

// ---------- 表示 ----------
export function aiView() {
  if (!Sync.isConfigured()) {
    return `<h1 class="page-h">AI</h1>
      <p>AIを使うには、先にクラウド同期の設定が必要です。</p>
      <a class="btn" href="#/settings" style="margin-top:14px">設定を開く</a>`;
  }

  const head = `<div class="page-h-row"><h1 class="page-h">AI</h1>
    <div class="head-actions">
      ${st.view === 'chat' ? '<button id="aiHist">履歴</button>' : '<button id="aiBack">戻る</button>'}
      <button id="aiNew">新しい会話</button>
    </div></div>`;

  if (st.view === 'history') {
    return `${head}
      ${st.history.length ? `<ul class="hist">${st.history.map((c) => `<li><button data-chat="${esc(c.id)}">
        <span>${esc(c.title || '（無題）')}</span><span class="muted small">${esc(c.day.slice(5).replace('-', '/'))}</span></button></li>`).join('')}</ul>`
        : '<p class="muted">まだ会話がありません</p>'}
      ${st.error ? `<p class="err">${esc(st.error)}</p>` : ''}`;
  }

  const empty = !st.display.length && !st.busy;
  const body = empty
    ? `<div class="ai-empty">
        <p>話しかけるだけで、勉強時間の記録・チェック・会社の追加や更新・週の振り返りができます。</p>
        <div class="suggest">${SUGGESTIONS.map((s) => `<button class="chip" data-say="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      </div>`
    : `<div class="chat" id="chat">${st.display.map((m) => m.r === 'act'
        ? `<div class="act">✓ ${esc(m.t)}</div>`
        : `<div class="bubble ${m.r === 'user' ? 'me' : 'ai'}">${esc(m.t)}</div>`).join('')}
        ${st.busy ? '<div class="bubble ai typing">…</div>' : ''}</div>`;

  return `${head}
    ${st.loading ? '<p class="muted">読み込み中…</p>' : body}
    ${st.error ? `<p class="err" role="alert">${esc(st.error)}</p>` : ''}
    <div class="composer ai-composer">
      <textarea id="aiInput" rows="1" placeholder="AIに話しかける" ${st.busy ? 'disabled' : ''}>${esc(st.draft)}</textarea>
      <button class="btn" id="aiSend" ${st.busy ? 'disabled' : ''} aria-label="送信">送信</button>
    </div>`;
}

export function bindAi() {
  const $ = (s) => document.querySelector(s);
  $('#aiHist')?.addEventListener('click', openHistory);
  $('#aiBack')?.addEventListener('click', () => { st.view = 'chat'; rerender(); });
  $('#aiNew')?.addEventListener('click', newChat);
  document.querySelectorAll('[data-say]').forEach((b) => b.addEventListener('click', () => {
    // 「会社を追加したい」のように続きが必要なものは、入力欄に入れて続きを書いてもらう
    const t = b.dataset.say;
    if (/したい$/.test(t) && t !== '週の振り返りをしたい') {
      st.draft = `${t}：`;
      rerender();
      const i = $('#aiInput');
      i?.focus();
      i?.setSelectionRange(i.value.length, i.value.length);
    } else send(t);
  }));
  document.querySelectorAll('[data-chat]').forEach((b) => b.addEventListener('click', () => openChat(b.dataset.chat)));
  const input = $('#aiInput');
  if (input) {
    const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(140, input.scrollHeight)}px`; };
    grow();
    input.addEventListener('input', () => { st.draft = input.value; grow(); });
    input.addEventListener('keydown', (e) => {
      // パソコンでは Enter で送信、Shift+Enter で改行（日本語変換中の Enter は除く）
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !('ontouchstart' in window)) { e.preventDefault(); send(input.value); }
    });
  }
  $('#aiSend')?.addEventListener('click', () => send($('#aiInput')?.value));
  const chat = $('#chat');
  if (chat) chat.lastElementChild?.scrollIntoView({ block: 'end' });
}
