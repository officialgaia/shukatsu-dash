// Worker との同期。
// ・変更があれば少し待ってから送る（まとめ送り）
// ・アプリを開いたとき／画面に戻ったとき／ネットにつながったときにも同期
// ・トークンはこの端末の localStorage にだけ保存する

import * as S from './store.js';

const KEY = 'shukatsu-dash:sync';
const DEBOUNCE_MS = 1500;

let cfg = loadCfg(); // { token, apiBase, since }
let defaultBase = '';
let status = 'off'; // off | idle | syncing | error | offline | auth
let lastError = '';
let lastOk = cfg.lastOk || 0;
let timer = null;
let running = null;
const listeners = new Set();

function loadCfg() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}
function saveCfg() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch { /* 保存できなくても動作は続ける */ }
}

function setStatus(s, err = '') {
  status = s;
  lastError = err;
  listeners.forEach((fn) => fn());
}

export function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function apiBase() {
  return (cfg.apiBase || defaultBase || '').replace(/\/$/, '');
}
export function hasToken() {
  return !!cfg.token;
}
export function isConfigured() {
  return !!(apiBase() && cfg.token);
}
export function getStatus() {
  return { status, lastError, lastOk, pending: S.pendingCount(), apiBase: apiBase(), defaultBase, customBase: cfg.apiBase || '' };
}

async function api(path, { method = 'GET', body, token = cfg.token, base = apiBase() } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* 本文なし */ }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 同期以外の API（AIコーチなど）を呼ぶ */
export function call(path, opts = {}) {
  if (!isConfigured()) {
    const e = new Error('同期の設定がまだです（設定でアクセストークンを入力してください）');
    e.status = 0;
    return Promise.reject(e);
  }
  return api(path, opts).catch((e) => {
    if (e.message === 'Failed to fetch') e.message = 'Worker につながりません。電波を確認してください。';
    throw e;
  });
}

/** トークン（と必要なら API の URL）を確かめて保存し、初回同期する */
export async function connect(token, customBase) {
  const base = (customBase || defaultBase || '').replace(/\/$/, '');
  if (!base) throw new Error('Worker の URL が設定されていません');
  await api('/api/ping', { token, base });
  const first = cfg.token !== token || (cfg.apiBase || '') !== (customBase || '');
  cfg = { ...cfg, token, apiBase: customBase || '', ...(first ? { since: 0 } : {}) };
  saveCfg();
  if (first) S.markAllPending();
  return syncNow();
}

export function disconnect() {
  cfg = {};
  saveCfg();
  setStatus('off');
}

export function schedule() {
  if (!isConfigured()) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, DEBOUNCE_MS);
}

export function syncNow() {
  if (!isConfigured()) {
    setStatus('off');
    return Promise.resolve();
  }
  if (running) return running.then(() => (S.pendingCount() ? syncNow() : undefined));
  clearTimeout(timer);
  const token = cfg.token;
  running = (async () => {
    if (!navigator.onLine) return setStatus('offline');
    setStatus('syncing');
    try {
      await syncRounds();
      if (cfg.token !== token) return setStatus(isConfigured() ? 'idle' : 'off'); // 途中で接続を解除・変更した
      lastOk = Date.now();
      cfg.lastOk = lastOk;
      saveCfg();
      setStatus('idle');
    } catch (e) {
      if (cfg.token !== token) return setStatus(isConfigured() ? 'idle' : 'off');
      if (e.status === 401) setStatus('auth', 'トークンが違います');
      else if (!navigator.onLine) setStatus('offline');
      else setStatus('error', e.message === 'Failed to fetch' ? 'Worker につながりません' : e.message);
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

async function syncRounds() {
  // 未送信が多いときは500件ずつ分けて送る（最大10回）
  for (let round = 0; round < 10; round++) {
    const sent = S.takePending().slice(0, 500);
    const res = await api('/api/sync', { method: 'POST', body: { since: cfg.since || 0, changes: sent } });
    S.clearPending(sent);
    S.applyRemote(res.changes || []);
    cfg.since = res.next;
    if (S.takePending().length === 0) break;
  }
}

export async function init(base) {
  defaultBase = base || '';
  S.onChange(() => {
    if (S.pendingCount()) schedule();
  });
  window.addEventListener('online', syncNow);
  window.addEventListener('offline', () => setStatus('offline'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
  });
  if (isConfigured()) syncNow();
}
