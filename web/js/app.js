import * as S from './store.js';
import * as Sync from './sync.js';
import { aiView, bindAi, enterAi, setAiRerender } from './ai.js';
import { notifySection, installSection, bindNotify, resetNotify, setNotifyRerender, refreshSubscription, device } from './notify.js';
import {
  today, addDays, daysBetween, mondayOf, weekDays, md, mdDow, dow, isSunday, esc, fmtH,
  currentWeek, targetFor, activeDecisions, weekItemId,
} from './util.js';
import { weeklyChart } from './chart.js';

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
let plan = null;
let recordDay = null; // 記録タブで選んでいる日

const TABS = [
  { id: 'home', label: 'ホーム', icon: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>' },
  { id: 'record', label: '記録', icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>' },
  { id: 'ai', label: 'AI', icon: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>' },
  { id: 'weeks', label: '週チェック', icon: '<path d="M9 11l2 2 4-4"/><rect x="3" y="4" width="18" height="16" rx="2"/>' },
  { id: 'companies', label: '会社', icon: '<path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M14 9h5a1 1 0 0 1 1 1v11M2 21h20M7 8h3M7 12h3M7 16h3"/>' },
];

// ---------- 起動 ----------
async function boot() {
  try {
    const res = await fetch('data/plan.json', { cache: 'no-cache' });
    plan = await res.json();
  } catch (e) {
    app.innerHTML = `<div class="card"><h2>予定データを読めませんでした</h2><p class="muted">data/plan.json を確認してください。<br>${esc(e.message)}</p></div>`;
    return;
  }
  let config = {};
  try {
    config = await (await fetch('data/config.json', { cache: 'no-cache' })).json();
  } catch { /* config.json がなくても端末内だけで動く */ }
  S.seedCompanies(plan.initialCompanies);
  renderNav();
  window.addEventListener('hashchange', render);
  S.onChange(render);
  Sync.onStatus(renderSyncStatus);
  // 振り返り画面だけを描き直す（ほかの画面にいるときは何もしない）
  setAiRerender(() => { if (route() === 'ai') render(); });
  setNotifyRerender(() => { if (route() === 'settings') render(); });
  render();
  Sync.init(config.apiBase);
  renderSyncStatus();
  refreshSubscription();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

function route() {
  const id = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'home';
  if (id === 'review') return 'ai'; // 以前の振り返り画面は AI タブに統合
  return [...TABS.map((t) => t.id), 'settings', 'policy'].includes(id) ? id : 'home';
}

/** '#/ai/review' の 'review' の部分 */
function subRoute() {
  return location.hash.replace(/^#\/?/, '').split('/')[1] || (location.hash.startsWith('#/review') ? 'review' : '');
}

function renderNav() {
  $('#tabbar').innerHTML = TABS.map(
    (t) => `<a href="#/${t.id}" data-tab="${t.id}"><svg viewBox="0 0 24 24" aria-hidden="true">${t.icon}</svg><span>${t.label}</span></a>`,
  ).join('');
}

function render() {
  const r = route();
  document.querySelectorAll('#tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === r));
  const entering = app.dataset.route !== r;
  const keepScroll = entering ? 0 : window.scrollY;
  app.dataset.route = r;
  if (r === 'ai' && (entering || subRoute())) {
    const sub = subRoute();
    // '#/ai/review' は一度だけ使い、URL は '#/ai' に戻す（再読み込みで二重に送らないため）
    if (sub) history.replaceState(null, '', `${location.pathname}${location.search}#/ai`);
    enterAi(sub);
  }
  if (entering && r === 'settings') resetNotify();
  const views = { home, record, weeks, companies, policy, settings, ai: aiView };
  bind.ai = bindAi;
  app.innerHTML = views[r]();
  bind[r]?.(entering);
  window.scrollTo(0, keepScroll);
}

// ---------- 同期の状態表示 ----------
const SYNC_LABEL = {
  off: '同期していません（この端末だけに保存）',
  idle: '同期済み',
  syncing: '同期中…',
  offline: 'オフライン（つながったら送ります）',
  error: '同期できませんでした',
  auth: 'トークンが違います',
};

function syncText() {
  const st = Sync.getStatus();
  let t = SYNC_LABEL[st.status] || st.status;
  if (st.status === 'error' && st.lastError) t += `：${st.lastError}`;
  if (st.pending && st.status !== 'syncing') t += `（未送信 ${st.pending}件）`;
  if (st.lastOk) {
    const d = new Date(st.lastOk);
    t += ` ・最終 ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return t;
}

function renderSyncStatus() {
  const st = Sync.getStatus();
  const dot = $('#syncDot');
  if (dot) {
    const s = st.status === 'idle' && st.pending ? 'syncing' : st.status;
    dot.className = `sync-dot s-${s}`;
    dot.title = syncText();
    dot.setAttribute('aria-label', syncText());
  }
  const info = $('#syncInfo');
  if (info) info.textContent = syncText();
}

// ---------- 共通部品 ----------
function weekLabel(w) {
  if (w.kind === 'after') return `${md(w.start)}〜`;
  return `${md(w.start)}〜${md(addDays(w.start, 6))}`;
}

function sideList(w, side, title) {
  const items = w[side] || [];
  if (!items.length) return '';
  return `<div class="group"><div class="group-h">${title}</div><ul class="checks">${items
    .map((t, i) => {
      const id = weekItemId(w.start, side, i);
      const on = S.isWeekChecked(id);
      return `<li><button class="chk ${on ? 'on' : ''}" data-week="${esc(id)}" aria-pressed="${on}"><span class="box" aria-hidden="true"></span><span>${esc(t)}</span></button></li>`;
    })
    .join('')}</ul></div>`;
}

function weekBody(w) {
  return sideList(w, 'tocho', '都庁') + sideList(w, 'minkan', '民間') + sideList(w, 'other', 'その他');
}

function weekProgress(w) {
  let done = 0, total = 0;
  for (const side of ['tocho', 'minkan', 'other']) {
    (w[side] || []).forEach((_, i) => {
      total++;
      if (S.isWeekChecked(weekItemId(w.start, side, i))) done++;
    });
  }
  return { done, total };
}

function bindWeekChecks() {
  app.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => S.toggleWeek(b.dataset.week)));
}

function hoursBar(total, t) {
  if (!t) return `<p class="hours"><b>${fmtH(total)}</b> 時間</p>`;
  const scaleMax = Math.max(t.max, total);
  const pct = (v) => `${Math.min(100, (v / scaleMax) * 100)}%`;
  let note;
  if (total >= t.min) note = '目標に届きました';
  else if (total >= t.floor) note = `目標まであと ${fmtH(t.min - total)} 時間`;
  else note = `最低ライン ${t.floor} 時間まであと ${fmtH(t.floor - total)} 時間`;
  return `
    <p class="hours"><b>${fmtH(total)}</b> / ${t.min}〜${t.max} 時間</p>
    <div class="bar" role="img" aria-label="今週${fmtH(total)}時間、目標${t.min}〜${t.max}時間">
      <div class="bar-fill" style="width:${pct(total)}"></div>
      <div class="bar-tick" style="left:${pct(t.min)}"></div>
    </div>
    <p class="muted small">${note}</p>`;
}

// ---------- ホーム ----------
function home() {
  const day = today();
  const w = currentWeek(plan, day);
  const mon = mondayOf(day);
  const total = S.sumHours(weekDays(mon));
  const t = targetFor(plan, mon);
  const left = daysBetween(day, plan.examDate);
  const daily = S.getDaily(day);
  const banners = activeDecisions(plan, day);
  const [, m, d] = day.split('-').map(Number);

  const [ey, em, ed] = plan.examDate.split('-').map(Number);
  const remain = left > 0 ? `<b>${left}</b>日` : left === 0 ? '<b>本日</b>' : '終了';

  const notices = [];
  for (const b of banners) notices.push(`<p class="notice"><b>${esc(b.title)}</b>　${esc(b.text)}</p>`);
  const dv = device();
  if (dv.ios && !dv.standalone) notices.push('<a class="notice link-row" href="#/settings">ホーム画面に追加して使ってください <span>›</span></a>');
  if (!Sync.isConfigured()) notices.push('<a class="notice link-row" href="#/settings">同期を設定する <span>›</span></a>');
  if (isSunday(day)) notices.push('<a class="notice link-row strong" href="#/ai/review">AIと週の振り返りをする <span>›</span></a>');

  return `
    <p class="dateline">${m}月${d}日（${dow(day)}）</p>
    <table class="ticket" aria-label="受験票">
      <tr><th>試験</th><td colspan="3">${esc(plan.examName)}</td></tr>
      <tr><th>試験日</th><td class="nowrap">${ey}/${em}/${ed}（${dow(plan.examDate)}）</td><th>残り</th><td class="remain">${remain}</td></tr>
    </table>
    ${notices.join('')}

    <section class="sec">
      <h2>今日<button class="h-link" id="addEv">追加</button></h2>
      <ul class="checks">
        ${S.visibleChecks(plan.dailyChecks, day).map((c) => `
          <li class="ev-row"><button class="chk ${daily[c.id] ? 'on' : ''}" data-daily="${c.id}" aria-pressed="${!!daily[c.id]}">
            <span class="box" aria-hidden="true"></span><span>${esc(c.label)}</span></button>
            <button class="ev-edit" data-dailyoff="${c.id}" aria-label="「${esc(c.label)}」を消す">消す</button></li>`).join('')}
        ${S.listEvents(day, day).map((e) => `
          <li class="ev-row"><button class="chk ${e.done ? 'on' : ''}" data-evdone="${esc(e.id)}" aria-pressed="${!!e.done}">
            <span class="box" aria-hidden="true"></span><span>${e.time ? `<span class="ev-time">${esc(e.time)}</span>` : ''}${esc(e.title)}</span></button>
            <button class="ev-edit" data-ev="${esc(e.id)}" aria-label="「${esc(e.title)}」を編集">編集</button></li>`).join('')}
      </ul>
      ${(daily.skip || []).length ? `<button class="restore" id="unskip">今日だけ消した項目を戻す</button>` : ''}
      <dialog id="evDlg"></dialog>
    </section>

    <section class="sec">
      <h2>今週<span class="h-sub">${w ? weekLabel(w) : ''}</span></h2>
      ${w ? `<p class="phase">${esc(w.month)}　${esc(w.phase)}</p>` : ''}
      ${w ? weekBody(w) : '<p class="muted">予定がありません</p>'}
    </section>

    <section class="sec">
      <h2>勉強時間<a class="h-link" href="#/record">記録する</a></h2>
      ${hoursBar(total, t)}
    </section>

    ${lastReviewCard()}
  `;
}

/** 今日の項目を追加・編集する小さなフォーム（内容と日付だけ） */
function eventForm(e, day) {
  const isNew = !e;
  e = e || { title: '', date: day, time: '' };
  return `<form method="dialog" id="evForm">
    <label>${isNew ? 'やることを追加' : '編集'}<input name="title" required value="${esc(e.title)}" autocomplete="off" placeholder="例：SPIの問題集を10ページ"></label>
    <div class="row2">
      <label>日付<input type="date" name="date" required value="${esc(e.date)}"></label>
      <label>時刻（任意）<input type="time" name="time" value="${esc(e.time || '')}" step="300"></label>
    </div>
    <div class="dlg-actions">
      ${isNew ? '' : '<button type="button" class="btn danger" id="evDel">削除</button>'}
      <span class="spacer"></span>
      <button type="button" class="btn ghost" id="evCancel">やめる</button>
      <button type="submit" class="btn">保存</button>
    </div>
  </form>`;
}

function bindEvents() {
  const dlg = $('#evDlg');
  if (!dlg) return;
  const open = (id) => {
    const e = id ? S.getEvent(id) : null;
    dlg.innerHTML = eventForm(e, today());
    dlg.showModal();
    $('#evCancel', dlg).addEventListener('click', () => dlg.close());
    $('#evDel', dlg)?.addEventListener('click', () => {
      if (confirm(`「${e.title}」を削除しますか？`)) { dlg.close(); S.deleteEvent(id); }
    });
    $('#evForm', dlg).addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const title = String(f.get('title')).trim();
      const date = String(f.get('date'));
      if (!title || !date) return;
      dlg.close();
      S.upsertEvent({ id: id || undefined, title, date, time: String(f.get('time') || '') || null });
    });
  };
  $('#addEv')?.addEventListener('click', () => open(null));
  // 毎日のチェックを消す：今日だけ／ずっと
  app.querySelectorAll('[data-dailyoff]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.dailyoff;
    const label = plan.dailyChecks.find((c) => c.id === id)?.label || id;
    dlg.innerHTML = `<form method="dialog" class="offform">
      <p>「${esc(label)}」を一覧から消します。</p>
      <button type="button" class="btn wide" data-off="day">今日だけ消す</button>
      <button type="button" class="btn ghost wide" data-off="always">ずっと消す（設定から戻せます）</button>
      <button type="button" class="btn ghost wide" data-off="cancel">やめる</button>
    </form>`;
    dlg.showModal();
    dlg.querySelectorAll('[data-off]').forEach((x) => x.addEventListener('click', () => {
      dlg.close();
      if (x.dataset.off === 'day') S.setDailySkip(today(), id, true);
      if (x.dataset.off === 'always') S.setCheckHidden(id, true);
    }));
  }));
  $('#unskip')?.addEventListener('click', () => {
    for (const id of S.getDaily(today()).skip || []) S.setDailySkip(today(), id, false);
  });
  app.querySelectorAll('[data-evdone]').forEach((b) => b.addEventListener('click', () => {
    const e = S.getEvent(b.dataset.evdone);
    if (e) S.upsertEvent({ ...e, done: !e.done });
  }));
  app.querySelectorAll('[data-ev]').forEach((b) => b.addEventListener('click', () => open(b.dataset.ev)));
}

/** 前回の振り返りで決めた「来週やること」（今週の分だけ表示） */
function lastReviewCard() {
  const lr = S.getSetting('lastReview', null);
  if (!lr?.next?.length) return '';
  // 振り返った週の翌週が今週のときだけ出す
  if (addDays(lr.week, 7) !== mondayOf(today())) return '';
  return `<section class="sec"><h2>前回の振り返りで決めたこと</h2><ol class="plain-ol">${lr.next.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></section>`;
}

const bind = {};
bind.home = () => {
  bindEvents();
  app.querySelectorAll('[data-daily]').forEach((b) => b.addEventListener('click', () => S.toggleDaily(today(), b.dataset.daily)));
  bindWeekChecks();
};

// ---------- 記録 ----------
function record() {
  const day = today();
  if (!recordDay) recordDay = day;
  const cur = S.getHours(recordDay);
  const mon = mondayOf(recordDay);
  const days = weekDays(mon);

  // グラフ：plan の最初の週〜今週（それ以降の記録があればそこまで）
  const first = plan.weeks[0].start;
  const lastMon = mondayOf(day);
  const series = [];
  for (let m = first; m <= lastMon; m = addDays(m, 7)) {
    series.push({ mon: m, total: S.sumHours(weekDays(m)), target: targetFor(plan, m) });
  }

  return `
    <section class="sec">
      <div class="day-pick">
        <button class="icon-btn" data-shift="-1" aria-label="前の日">‹</button>
        <label class="date-wrap"><input type="date" id="recDate" value="${recordDay}" max="${day}"><span>${mdDow(recordDay)}${recordDay === day ? '・今日' : ''}</span></label>
        <button class="icon-btn" data-shift="1" aria-label="次の日" ${recordDay >= day ? 'disabled' : ''}>›</button>
      </div>
      <div class="stepper">
        <button class="step" data-step="-0.5" aria-label="0.5時間減らす">−</button>
        <div class="step-val"><b>${fmtH(cur.h)}</b><small>時間</small></div>
        <button class="step" data-step="0.5" aria-label="0.5時間増やす">＋</button>
      </div>
      <details class="more" ${cur.tags.length || S.getSetting('tagsOpen', false) ? 'open' : ''} id="tagBox"><summary>科目を付ける${cur.tags.length ? `：${esc(cur.tags.join('・'))}` : '（任意）'}</summary>
        <div class="tags">${plan.studyTags.map((t) => `<button class="chip ${cur.tags.includes(t) ? 'on' : ''}" data-tag="${esc(t)}" aria-pressed="${cur.tags.includes(t)}">${esc(t)}</button>`).join('')}</div>
      </details>
    </section>

    <section class="sec">
      <h2>${md(mon)}〜の週<span class="h-sub">合計 ${fmtH(S.sumHours(days))} 時間</span></h2>
      <ul class="daylist">
        ${days.map((d) => {
          const h = S.getHours(d);
          return `<li><button data-pick="${d}" class="${d === recordDay ? 'sel' : ''}" ${d > day ? 'disabled' : ''}>
            <span class="dl-d">${mdDow(d)}</span>
            <span class="dl-tags">${esc(h.tags.join('・'))}</span>
            <span class="dl-h">${h.h ? fmtH(h.h) + 'h' : '—'}</span></button></li>`;
        }).join('')}
      </ul>
    </section>

    <section class="sec">
      <h2>週ごとの合計</h2>
      ${weeklyChart(series, plan.studyTargets.floor.hours, lastMon)}
      <details class="table-view"><summary>表で見る</summary>
        <table><thead><tr><th>週</th><th>合計</th><th>目標</th></tr></thead><tbody>
        ${series.slice().reverse().map((s) => `<tr><td>${md(s.mon)}〜</td><td>${fmtH(s.total)}h</td><td>${s.target ? `${s.target.min}〜${s.target.max}h` : '—'}</td></tr>`).join('')}
        </tbody></table>
      </details>
    </section>`;
}

bind.record = () => {
  const day = today();
  const cur = () => S.getHours(recordDay);
  $('#recDate').addEventListener('change', (e) => {
    if (e.target.value) { recordDay = e.target.value > day ? day : e.target.value; render(); }
  });
  app.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', () => {
    const n = addDays(recordDay, Number(b.dataset.shift));
    if (n <= day) { recordDay = n; render(); }
  }));
  app.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { recordDay = b.dataset.pick; render(); }));
  app.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    const c = cur();
    S.setHours(recordDay, Math.min(24, c.h + Number(b.dataset.step)), c.tags);
  }));
  app.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => S.setHours(recordDay, Number(b.dataset.set), cur().tags)));
  $('#tagBox')?.addEventListener('toggle', (e) => S.setSetting('tagsOpen', e.target.open));
  app.querySelectorAll('[data-tag]').forEach((b) => b.addEventListener('click', () => {
    const c = cur();
    const t = b.dataset.tag;
    const tags = c.tags.includes(t) ? c.tags.filter((x) => x !== t) : [...c.tags, t];
    S.setHours(recordDay, c.h, tags);
  }));
  // グラフは最新週が見えるよう右端へ
  const sc = $('.chart-scroll');
  if (sc) sc.scrollLeft = sc.scrollWidth;
  bindChartTips();
};

function bindChartTips() {
  const tip = $('.chart-tip');
  if (!tip) return;
  app.querySelectorAll('[data-tip]').forEach((el) => {
    const show = () => {
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      app.querySelectorAll('.bar-hit.sel').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
    };
    el.addEventListener('click', show);
    el.addEventListener('mouseenter', show);
  });
}

// ---------- 週チェック ----------
function weeks() {
  const day = today();
  const cw = currentWeek(plan, day);
  const all = [...plan.weeks.map((w) => ({ ...w, kind: 'week' })), ...(plan.afterExam ? [{ ...plan.afterExam, kind: 'after' }] : [])];
  let lastMonth = '';
  return `
    <h1 class="page-h">週ごとにやること</h1>
    ${all.map((w) => {
      const isCur = cw && cw.start === w.start;
      const past = !isCur && w.kind !== 'after' && addDays(w.start, 6) < day;
      const { done, total } = weekProgress(w);
      const head = w.month !== lastMonth ? `<h3 class="month-h">${esc(w.month)}${w.kind === 'after' ? '' : `：${esc(w.phase)}`}</h3>` : '';
      lastMonth = w.month;
      return `${head}<details class="wk ${isCur ? 'cur' : ''} ${past ? 'past' : ''}" ${past ? '' : 'open'} ${isCur ? 'id="cur-week"' : ''}>
        <summary><span>${weekLabel(w)}${w.note ? `（${esc(w.note)}）` : ''}${isCur ? '<em>今週</em>' : ''}</span><span class="prog ${done === total && total ? 'done' : ''}">${done}/${total}</span></summary>
        <div class="wk-body">${weekBody(w)}</div>
      </details>`;
    }).join('')}`;
}
bind.weeks = (entering) => {
  bindWeekChecks();
  const cur = $('#cur-week');
  if (cur && entering) setTimeout(() => cur.scrollIntoView({ block: 'start' }), 0);
};

// ---------- 会社 ----------
let companyFilter = 'all';
function companies() {
  const list = S.listCompanies().sort((a, b) => (a.rank + a.name).localeCompare(b.rank + b.name, 'ja'));
  const count = (r) => list.filter((c) => c.rank === r).length;
  const offers = list.filter((c) => c.stage === '内定').length;
  const active = list.filter((c) => c.rank !== 'C' && c.stage !== '見送り').length;
  const shown = companyFilter === 'all' ? list : list.filter((c) => c.rank === companyFilter);
  const rankText = Object.fromEntries(plan.abc.map((x) => [x.rank, x.text]));

  return `
    <div class="page-h-row"><h1 class="page-h">会社</h1><button class="btn small-btn" id="addCo">追加</button></div>
    <p class="summary">追っている ${active}社・内定 ${offers}社<span class="muted">（A ${count('A')}・B ${count('B')}・C ${count('C')}）</span></p>
    <div class="seg" role="tablist">
      ${['all', 'A', 'B', 'C'].map((r) => `<button data-filter="${r}" class="${companyFilter === r ? 'on' : ''}">${r === 'all' ? 'すべて' : r}</button>`).join('')}
    </div>
    ${companyFilter !== 'all' ? `<p class="muted small">${esc(rankText[companyFilter])}</p>` : ''}
    <ul class="colist">
      ${shown.length ? shown.map((c) => `
        <li><button data-co="${c.id}">
          <span class="rank r-${c.rank}">${c.rank}</span>
          <span class="co-main"><b>${esc(c.name)}</b>${c.memo ? `<small>${esc(c.memo)}</small>` : ''}</span>
          <span class="stage s-${esc(c.stage)}">${esc(c.stage)}</span>
        </button></li>`).join('') : '<li class="muted empty">まだありません</li>'}
    </ul>
    <details class="more"><summary>A・B・C の基準</summary>
      <dl class="tiers">${plan.abc.map((x) => `<dt>${x.rank}</dt><dd>${esc(x.text)}</dd>`).join('')}</dl>
      <p class="muted small">目安：入口15〜20社 → 本格選考5〜10社 → 内定1〜2社</p>
    </details>
    <dialog id="coDlg"></dialog>`;
}

function companyForm(c) {
  const isNew = !c;
  c = c || { name: '', rank: 'A', stage: plan.companyStages[0], memo: '' };
  return `<form method="dialog" id="coForm">
    <h2>${isNew ? '会社を追加' : '会社を編集'}</h2>
    <label>会社名<input name="name" required value="${esc(c.name)}" autocomplete="off"></label>
    <fieldset class="seg"><legend>仕分け</legend>
      ${plan.abc.map((x) => `<label><input type="radio" name="rank" value="${x.rank}" ${c.rank === x.rank ? 'checked' : ''}><span>${x.rank}</span></label>`).join('')}
    </fieldset>
    <label>選考段階<select name="stage">${plan.companyStages.map((s) => `<option ${c.stage === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
    <label>メモ<textarea name="memo" rows="3">${esc(c.memo)}</textarea></label>
    <div class="dlg-actions">
      ${isNew ? '' : '<button type="button" class="btn danger" id="coDel">削除</button>'}
      <span class="spacer"></span>
      <button type="button" class="btn ghost" id="coCancel">やめる</button>
      <button type="submit" class="btn" value="save">保存</button>
    </div>
  </form>`;
}

bind.companies = () => {
  app.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { companyFilter = b.dataset.filter; render(); }));
  const dlg = $('#coDlg');
  const open = (id) => {
    const c = id ? S.getCompany(id) : null;
    dlg.innerHTML = companyForm(c);
    dlg.showModal();
    $('#coCancel', dlg).addEventListener('click', () => dlg.close());
    $('#coDel', dlg)?.addEventListener('click', () => {
      if (confirm(`「${c.name}」を削除しますか？`)) { dlg.close(); S.deleteCompany(id); }
    });
    $('#coForm', dlg).addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const name = String(f.get('name')).trim();
      if (!name) return;
      dlg.close();
      S.upsertCompany({ id: id || undefined, name, rank: f.get('rank'), stage: f.get('stage'), memo: String(f.get('memo')).trim() });
    });
  };
  $('#addCo').addEventListener('click', () => open(null));
  app.querySelectorAll('[data-co]').forEach((b) => b.addEventListener('click', () => open(b.dataset.co)));
};

// ---------- 方針 ----------
function policy() {
  const p = plan.policy;
  const ul = (arr) => `<ul class="dots">${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  const tiers = (s) => `<h3>${esc(s.title)}</h3>${s.note ? `<p class="muted small">${esc(s.note)}</p>` : ''}
    <dl class="tiers">${s.tiers.map((t) => `<dt>${esc(t.label)}</dt><dd>${esc(t.subjects.join('・'))}${t.note ? `<small>${esc(t.note)}</small>` : ''}</dd>`).join('')}</dl>
    ${s.decision ? `<p class="note">${esc(s.decision)}</p>` : ''}`;
  return `
    <h1 class="page-h">方針</h1>
    <section class="card"><h2>全体の方針</h2>
      <h3>公務員</h3>${ul(p.public)}
      <h3>民間</h3>${ul(p.private)}
      <h3>保険ルール</h3>${ul(p.insurance)}
    </section>
    <section class="card"><h2>毎日の土台</h2><p>${esc(plan.dailyBase)}</p></section>
    <section class="card"><h2>1日の型</h2>
      ${plan.dayTemplates.map((d) => `<h3>${esc(d.label)}${d.hours ? `<span class="muted small">（${esc(d.hours)}）</span>` : ''}</h3>
        ${d.slots.length ? `<dl class="tiers">${d.slots.map((s) => `<dt>${esc(s.time)}</dt><dd>${esc(s.text)}</dd>`).join('')}</dl>` : ''}
        ${d.todo ? `<p class="todo">${esc(d.todo)}</p>` : ''}`).join('')}
    </section>
    <section class="card"><h2>勉強時間の目標</h2>
      <dl class="tiers">${plan.studyTargets.periods.map((t) => `<dt>${esc(t.label)}</dt><dd>週${t.min}〜${t.max}時間</dd>`).join('')}
      <dt>最低ライン</dt><dd>週${plan.studyTargets.floor.hours}時間<small>${esc(plan.studyTargets.floor.label)}</small></dd></dl>
    </section>
    <section class="card"><h2>科目</h2>${tiers(plan.subjects.senmon)}${tiers(plan.subjects.kyoyo)}</section>
    <section class="card"><h2>民間のA・B・C</h2><dl class="tiers">${plan.abc.map((x) => `<dt>${x.rank}</dt><dd>${esc(x.text)}</dd>`).join('')}</dl></section>
    <section class="card"><h2>判断ポイント</h2><dl class="tiers">${plan.decisionPoints.map((d) => `<dt>${md(d.from)}〜${md(d.to)}</dt><dd>${esc(d.text)}</dd>`).join('')}</dl></section>
    <section class="card"><h2>日曜ルーティン</h2><ol class="dots">${plan.sundayRoutine.map((x) => `<li>${esc(x)}</li>`).join('')}</ol><p class="note">${esc(plan.sundayRule)}</p></section>
    <p class="center"><a class="link" href="#/settings">設定・バックアップ ›</a></p>`;
}

// ---------- 設定 ----------
function settings() {
  const st = Sync.getStatus();
  const connected = Sync.isConfigured();
  return `
    <h1 class="page-h">設定</h1>
    <section class="card"><h2>同期</h2>
      <p class="small" id="syncInfo">${esc(syncText())}</p>
      ${connected ? `
        <div class="btn-row">
          <button class="btn" id="syncNow">今すぐ同期</button>
          <button class="btn ghost" id="syncOff">この端末の接続を解除</button>
        </div>
        <p class="muted small">接続を解除しても、この端末のデータとクラウドのデータは消えません。</p>`
      : `
        <form id="syncForm" autocomplete="off">
          <label class="field">アクセストークン
            <input type="password" name="token" required minlength="32" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="受け取った長い文字列を貼り付け">
          </label>
          <details class="adv" ${st.defaultBase ? '' : 'open'}><summary>Worker の URL</summary>
            <label class="field">${st.defaultBase ? `通常は空でOK（既定：${esc(st.defaultBase)}）` : 'data/config.json が未設定のため入力してください'}
              <input type="url" name="base" value="${esc(st.customBase)}" placeholder="https://shukatsu-dash.xxxx.workers.dev" ${st.defaultBase ? '' : 'required'}>
            </label>
          </details>
          <button class="btn" type="submit">接続する</button>
          <p class="small" id="syncMsg" role="status"></p>
        </form>
        <p class="muted small">トークンはこの端末の中だけに保存されます。iPhone は「ホーム画面に追加」したアプリの方で入力してください（Safari とは保存場所が別です）。</p>`}
    </section>
    ${notifySection()}
    ${installSection()}
    <section class="card"><h2>毎日のチェック</h2>
      ${plan.dailyChecks.map((c) => `<label class="switch-row"><span>${esc(c.label)}<small>ホームの「今日」に毎日出す</small></span>
        <input type="checkbox" data-showcheck="${c.id}" ${S.hiddenChecks().includes(c.id) ? '' : 'checked'}></label>`).join('')}
    </section>
    <section class="card"><h2>計画</h2>
      <a class="notice link-row" href="#/policy">方針・科目・1日の型を見る <span>›</span></a>
    </section>
    <section class="card"><h2>バックアップ</h2>
      <p class="muted small">記録・チェック・会社リストを JSON ファイルに書き出せます。同期していても、ときどき書き出しておくと安心です。</p>
      <div class="btn-row">
        <button class="btn" id="exp">書き出す</button>
        <label class="btn ghost">読み込む<input type="file" id="imp" accept="application/json,.json" hidden></label>
      </div>
      <p class="muted small" id="impMsg"></p>
    </section>
    <section class="card"><h2>表示の確認用</h2>
      <p class="muted small">URL の末尾に <code>?today=2027-02-23</code> を付けると、その日として表示します。</p>
    </section>
    <section class="card"><h2>リセット</h2>
      <p class="muted small">記録・チェック・会社リストをすべて消します。同期中ならクラウドとほかの端末からも消えます。元に戻せません。</p>
      <button class="btn danger" id="reset">すべて消す</button>
    </section>`;
}
bind.settings = () => {
  renderSyncStatus();
  app.querySelectorAll('[data-showcheck]').forEach((el) => el.addEventListener('change', () => S.setCheckHidden(el.dataset.showcheck, !el.checked)));
  bindNotify();
  $('#syncNow')?.addEventListener('click', () => Sync.syncNow());
  $('#syncOff')?.addEventListener('click', () => {
    if (confirm('この端末の同期を解除しますか？（データは消えません）')) { Sync.disconnect(); render(); }
  });
  $('#syncForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const msg = $('#syncMsg');
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    msg.textContent = '確認しています…';
    try {
      await Sync.connect(String(f.get('token')).trim(), String(f.get('base') || '').trim());
      render();
    } catch (err) {
      msg.textContent = err.status === 401 ? 'トークンが違います。' : `つながりませんでした：${err.message === 'Failed to fetch' ? 'Worker の URL を確認してください' : err.message}`;
      btn.disabled = false;
    }
  });
  $('#exp').addEventListener('click', () => {
    const blob = new Blob([S.exportAll()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `shukatsu-backup-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#imp').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      if (!confirm('今のデータを、読み込んだ内容で置き換えますか？')) return;
      S.importAll(text);
    } catch (err) {
      $('#impMsg').textContent = `読み込めませんでした：${err.message}`;
    }
  });
  $('#reset').addEventListener('click', () => {
    if (confirm('本当にすべて消しますか？元に戻せません。')) {
      S.resetAll();
      S.seedCompanies(plan.initialCompanies, true);
    }
  });
};

boot();
