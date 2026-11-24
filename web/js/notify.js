// 通知とインストール（M4）：設定画面の「通知」「アプリとして追加」部分
import * as S from './store.js';
import * as Sync from './sync.js';
import { esc, today } from './util.js';

const st = { loaded: false, loading: false, busy: false, error: '', msg: '', config: null, subscribed: false };
let rerender = () => {};
let installPrompt = null;

export function setNotifyRerender(fn) {
  rerender = fn;
}

// Android の Chrome は「インストールしますか？」を出せる。合図を取っておく
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  rerender();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  rerender();
});

export function device() {
  const ua = navigator.userAgent;
  const android = /Android/.test(ua);
  // iPadOS は Mac のふりをするので、タッチ対応の Mac も iOS 扱いにする
  const ios = !android && (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  return { ios, android, standalone, supported, permission: supported ? Notification.permission : 'unsupported' };
}

function b64urlToBytes(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function currentSub() {
  if (!device().supported) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function load() {
  st.loading = true;
  st.error = '';
  try {
    const [config, sub] = await Promise.all([Sync.call('/api/push/config'), currentSub()]);
    st.config = config;
    st.subscribed = !!sub;
    st.loaded = true;
  } catch (e) {
    st.error = e.message;
  }
  st.loading = false;
  rerender();
}

/** ボタンを押したときに呼ぶ（iPhone ではタップの直後でないと許可を求められない） */
async function enable() {
  st.busy = true;
  st.error = '';
  st.msg = '';
  rerender();
  try {
    // 先に許可を求める（await を挟むと iPhone でタップと見なされなくなる）
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error(perm === 'denied' ? '通知がブロックされています。端末の設定で許可してください。' : '通知が許可されませんでした。');
    const key = st.config?.publicKey;
    if (!key) throw new Error('Worker に VAPID 鍵が設定されていません（README の手順を参照）');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // 鍵が変わっていたら作り直す
    if (sub && sub.options?.applicationServerKey) {
      const cur = new Uint8Array(sub.options.applicationServerKey);
      const want = b64urlToBytes(key);
      if (cur.length !== want.length || cur.some((v, i) => v !== want[i])) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
    await Sync.call('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), ua: navigator.userAgent } });
    S.setSetting('pushCheckedOn', today());
    st.subscribed = true;
    st.msg = 'この端末で通知を受け取れるようになりました。「テスト通知」で確かめてください。';
    st.config = await Sync.call('/api/push/config');
  } catch (e) {
    st.error = e.message;
  }
  st.busy = false;
  rerender();
}

async function disable() {
  st.busy = true;
  st.error = '';
  rerender();
  try {
    const sub = await currentSub();
    if (sub) {
      await Sync.call('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
    st.subscribed = false;
    st.msg = 'この端末の通知をやめました。';
    st.config = await Sync.call('/api/push/config');
  } catch (e) {
    st.error = e.message;
  }
  st.busy = false;
  rerender();
}

async function sendTest() {
  st.busy = true;
  st.error = '';
  st.msg = '';
  rerender();
  try {
    const sub = await currentSub();
    if (!sub) throw new Error('この端末は通知に登録されていません');
    const r = await Sync.call('/api/push/test', { method: 'POST', body: { endpoint: sub.endpoint } });
    if (r.sent) st.msg = 'テスト通知を送りました。数秒〜数十秒で届きます。';
    else if (r.removed) { st.subscribed = false; st.error = '購読が切れていました。もう一度「通知を受け取る」を押してください。'; }
    else st.error = `送れませんでした：${(r.errors || []).join(' / ')}`;
  } catch (e) {
    st.error = e.message;
  }
  st.busy = false;
  rerender();
}

async function saveSetting(kind, patch) {
  st.error = '';
  try {
    const r = await Sync.call('/api/push/settings', { method: 'POST', body: { [kind]: patch } });
    st.config.settings = r.settings;
    st.msg = '保存しました（すべての端末に共通）';
  } catch (e) {
    st.error = e.message;
  }
  rerender();
}

/** アプリを開いたときに購読を登録し直す（1日1回。端末側で更新されていても追いつく） */
export async function refreshSubscription() {
  try {
    if (!Sync.isConfigured() || !device().supported || Notification.permission !== 'granted') return;
    if (S.getSetting('pushCheckedOn', '') === today()) return;
    const sub = await currentSub();
    if (!sub) return;
    await Sync.call('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), ua: navigator.userAgent } });
    S.setSetting('pushCheckedOn', today());
  } catch { /* 次回また試す */ }
}

// ---------- 表示 ----------
const TIMES = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);

function iosGuide() {
  return `<div class="guide">
    <b>iPhone では、ホーム画面に追加したアプリからでないと通知を許可できません</b>
    <ol>
      <li>Safari でこのページを開く</li>
      <li>下の共有ボタン（□に↑）→「ホーム画面に追加」</li>
      <li>ホーム画面の「就活ボード」から開き、もう一度この画面で「通知を受け取る」を押す</li>
    </ol>
    <p class="muted small">iOS 16.4 以上が必要です。ホーム画面のアプリと Safari はデータが別なので、トークンもアプリの方で入力してください。</p>
  </div>`;
}

export function installSection() {
  const d = device();
  if (d.standalone) return '';
  let body;
  if (installPrompt) {
    body = `<button class="btn" id="installBtn">ホーム画面に追加する</button>`;
  } else if (d.ios) {
    body = `<ol class="dots small"><li>Safari の共有ボタン（□に↑）をタップ</li><li>「ホーム画面に追加」を選ぶ</li><li>ホーム画面のアイコンから開く</li></ol>`;
  } else if (d.android) {
    body = `<p class="small">Chrome の右上「︙」→「ホーム画面に追加」（または「アプリをインストール」）を選んでください。</p>`;
  } else {
    body = `<p class="small muted">スマホでこのページを開くと、ホーム画面に追加できます。</p>`;
  }
  return `<section class="card"><h2>アプリとして追加</h2>${body}</section>`;
}

export function notifySection() {
  const d = device();
  let body;
  if (!Sync.isConfigured()) {
    body = '<p class="muted small">通知を使うには、先に上の「同期」でトークンを入力してください。</p>';
  } else if (d.ios && !d.standalone) {
    body = iosGuide();
  } else if (!d.supported) {
    body = `<p class="small">このブラウザは通知に対応していません。${d.ios ? 'iOS 16.4 以上にアップデートしてください。' : 'Android は Chrome を使ってください。'}</p>`;
  } else {
    if (!st.loaded && !st.loading && !st.error) setTimeout(load, 0);
    const c = st.config;
    const denied = d.permission === 'denied';
    const row = (kind, label, sub) => {
      const s = c?.settings?.[kind] || { on: false, time: '07:00' };
      return `<div class="notif-row">
        <label class="switch-row"><span>${label}<small>${sub}</small></span>
          <input type="checkbox" data-n-on="${kind}" ${s.on ? 'checked' : ''} ${c ? '' : 'disabled'}></label>
        <select data-n-time="${kind}" ${c && s.on ? '' : 'disabled'} aria-label="${label}の時刻">
          ${TIMES.map((t) => `<option ${t === s.time ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>`;
    };
    body = `
      ${denied ? `<p class="err">通知がブロックされています。${d.ios ? '「設定」アプリ → 通知 → 就活ボード' : 'Chrome の「︙」→ 設定 → サイトの設定 → 通知'} で許可してください。</p>` : ''}
      <p class="small">${st.loading ? '確認中…' : st.subscribed ? '✓ この端末で通知を受け取っています' : 'この端末ではまだ通知を受け取っていません'}${c ? `<span class="muted">（登録済みの端末 ${c.devices}台）</span>` : ''}</p>
      <div class="btn-row">
        ${st.subscribed
          ? `<button class="btn" id="nTest" ${st.busy ? 'disabled' : ''}>テスト通知を送る</button><button class="btn ghost" id="nOff" ${st.busy ? 'disabled' : ''}>この端末の通知をやめる</button>`
          : `<button class="btn" id="nOn" ${st.busy || denied || !c ? 'disabled' : ''}>この端末で通知を受け取る</button>`}
      </div>
      ${st.msg ? `<p class="ok small" role="status">${esc(st.msg)}</p>` : ''}
      <h3>送る時刻（日本時間・すべての端末に共通）</h3>
      ${row('morning', '毎朝の通知', '今週のテーマを知らせます')}
      ${row('sunday', '日曜の振り返りの案内', '日曜だけ')}
      ${c?.preview ? `<details class="adv"><summary>文面の見本（今日の場合）</summary>
        <div class="notif-preview"><b>${esc(c.preview.morning.title)}</b><span>${esc(c.preview.morning.body)}</span></div>
        <div class="notif-preview"><b>${esc(c.preview.sunday.title)}</b><span>${esc(c.preview.sunday.body)}</span></div>
        ${c.planLoaded ? '' : '<p class="muted small">※ Worker が plan.json を読めていないため、文面が簡易版になっています（wrangler.toml の PLAN_URL を確認）。</p>'}
      </details>` : ''}`;
  }
  return `<section class="card"><h2>通知</h2>${body}${st.error ? `<p class="err" role="alert">${esc(st.error)}</p>` : ''}</section>`;
}

export function bindNotify() {
  const $ = (s) => document.querySelector(s);
  $('#nOn')?.addEventListener('click', enable);
  $('#nOff')?.addEventListener('click', disable);
  $('#nTest')?.addEventListener('click', sendTest);
  document.querySelectorAll('[data-n-on]').forEach((el) => el.addEventListener('change', () => saveSetting(el.dataset.nOn, { on: el.checked })));
  document.querySelectorAll('[data-n-time]').forEach((el) => el.addEventListener('change', () => saveSetting(el.dataset.nTime, { time: el.value })));
  $('#installBtn')?.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    rerender();
  });
}

/** 設定画面に入るたびに最新を取り直す */
export function resetNotify() {
  st.loaded = false;
  st.msg = '';
  st.error = '';
}
