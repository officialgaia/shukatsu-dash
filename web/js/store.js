// データ保存。まず端末（localStorage）に保存し、sync.js が Worker と同期する。
// レコードごとに更新時刻 u（ミリ秒）を持ち、同期では新しい方が勝つ。削除は del フラグで残す。
//
// 形：
//   daily:      { 'YYYY-MM-DD': { suuteki: bool, tac: bool, u } }
//   hours:      { 'YYYY-MM-DD': { h: number, tags: string[], u } }
//   weekChecks: { '<週開始>:<tocho|minkan|other>:<番号>': { v: bool, u } }
//   companies:  { '<id>': { id, name, rank, stage, memo, u, del? } }
//   settings:   端末だけの設定（同期しない）
//   pending:    { '<coll>\t<key>': true } … まだ送っていない変更

import { uid } from './util.js';

const KEY = 'shukatsu-dash:v1';
export const SYNC_COLLS = ['daily', 'hours', 'weekChecks', 'companies'];
const listeners = new Set();

function empty() {
  return { daily: {}, hours: {}, weekChecks: {}, companies: {}, settings: {}, pending: {}, seeded: false };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...empty(), ...JSON.parse(raw) };
  } catch (e) {
    console.warn('保存データを読めませんでした', e);
  }
  return empty();
}

let state = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('保存できませんでした', e);
  }
  listeners.forEach((fn) => fn());
}

/** レコードを書き込み、未送信として印を付ける */
function put(coll, key, rec) {
  state[coll][key] = { ...rec, u: Math.max(Date.now(), (state[coll][key]?.u || 0) + 1) };
  state.pending[`${coll}\t${key}`] = true;
  save();
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 初期の会社を入れる。端末が複数でも重複しないよう ID は固定（seed-1 …）。
 * 通常は u=1（どの端末で編集した内容にも負ける）で入れ、送信しない。
 * fresh=true（全消去のあと）は今の時刻で入れ直し、ほかの端末にも送る。
 */
export function seedCompanies(initial, fresh = false) {
  if (state.seeded && !fresh) return;
  (initial || []).forEach((c, i) => {
    const id = `seed-${i + 1}`;
    const rec = { id, name: c.name, rank: c.rank, stage: c.stage, memo: c.memo || '' };
    if (fresh) {
      state.companies[id] = { ...rec, u: Date.now() };
      state.pending[`companies\t${id}`] = true;
    } else if (!state.companies[id]) {
      state.companies[id] = { ...rec, u: 1 };
    }
  });
  state.seeded = true;
  save();
}

// ---- 毎日のチェック ----
export function getDaily(day) {
  return state.daily[day] || {};
}
export function toggleDaily(day, key) {
  const cur = state.daily[day] || {};
  put('daily', day, { ...cur, [key]: !cur[key] });
}

// ---- 勉強時間 ----
export function getHours(day) {
  return state.hours[day] || { h: 0, tags: [] };
}
export function setHours(day, h, tags) {
  put('hours', day, { h: Math.max(0, Math.round(h * 2) / 2), tags: tags || [] });
}
export function sumHours(days) {
  return days.reduce((s, d) => s + (state.hours[d]?.h || 0), 0);
}

// ---- 週チェック ----
export function isWeekChecked(id) {
  return !!state.weekChecks[id]?.v;
}
export function toggleWeek(id) {
  put('weekChecks', id, { v: !isWeekChecked(id) });
}

// ---- 会社 ----
export function listCompanies() {
  return Object.values(state.companies).filter((c) => !c.del);
}
export function getCompany(id) {
  const c = state.companies[id];
  return c && !c.del ? c : null;
}
export function upsertCompany(c) {
  const id = c.id || uid();
  put('companies', id, { ...state.companies[id], ...c, id });
  return id;
}
export function deleteCompany(id) {
  if (!state.companies[id]) return;
  put('companies', id, { id, del: true });
}

// ---- 端末だけの設定 ----
export function getSetting(k, dflt) {
  return k in state.settings ? state.settings[k] : dflt;
}
export function setSetting(k, v) {
  state.settings[k] = v;
  save();
}

// ---- 同期用 ----
export function pendingCount() {
  return Object.keys(state.pending).length;
}

/** 未送信の変更を取り出す（送信用の形） */
export function takePending() {
  return Object.keys(state.pending)
    .map((pk) => {
      const [c, k] = pk.split('\t');
      const rec = state[c]?.[k];
      if (!rec) return null;
      const { u, ...d } = rec;
      return { c, k, d, u };
    })
    .filter(Boolean);
}

/** 送信できた変更の印を外す（送信中に再度変更されたものは残す） */
export function clearPending(sent) {
  for (const { c, k, u } of sent) {
    if (state[c]?.[k]?.u === u) delete state.pending[`${c}\t${k}`];
  }
  save();
}

/** サーバーから来た変更を取り込む（新しい方が勝つ） */
export function applyRemote(changes) {
  let changed = false;
  for (const { c, k, d, u } of changes) {
    if (!SYNC_COLLS.includes(c)) continue;
    const local = state[c][k];
    if (!local || u > local.u) {
      state[c][k] = { ...d, u };
      delete state.pending[`${c}\t${k}`];
      changed = true;
    }
  }
  // M1 で入った初期の会社（ID がランダム）と、固定 ID の初期データが二重にならないようにする。
  // 一度も編集していない固定 ID の初期データ（u=1）で、同じ名前の会社がほかにあれば消す（送信しない）。
  const names = new Set(Object.values(state.companies).filter((c) => !c.del && !c.id?.startsWith('seed-')).map((c) => c.name));
  for (const [id, c] of Object.entries(state.companies)) {
    if (id.startsWith('seed-') && c.u === 1 && names.has(c.name)) {
      delete state.companies[id];
      changed = true;
    }
  }
  if (changed) save();
  return changed;
}

/** 端末にある全データを未送信扱いにする（初めて同期するとき） */
export function markAllPending() {
  for (const c of SYNC_COLLS) {
    for (const [k, rec] of Object.entries(state[c])) {
      if (rec.u === 1) continue; // 一度も編集していない初期データは送らない
      state.pending[`${c}\t${k}`] = true;
    }
  }
  save();
}

// ---- バックアップ ----
export function exportAll() {
  return JSON.stringify({ app: 'shukatsu-dash', exportedAt: new Date().toISOString(), data: state }, null, 2);
}
export function importAll(text) {
  const obj = JSON.parse(text);
  const data = obj && obj.data;
  if (!data || typeof data !== 'object' || !data.hours || !data.companies) throw new Error('形式が違います');
  state = { ...empty(), ...data, settings: state.settings };
  // 読み込んだ内容をほかの端末にも反映させる
  const now = Date.now();
  for (const c of SYNC_COLLS) {
    for (const k of Object.keys(state[c])) {
      state[c][k].u = Math.max(state[c][k].u || 0, now);
      state.pending[`${c}\t${k}`] = true;
    }
  }
  save();
}
export function resetAll() {
  // ほかの端末にも「消した」ことが伝わるよう、同期データは空の削除レコードで上書きする
  const now = Date.now();
  const next = { ...empty(), settings: state.settings, seeded: true };
  for (const c of SYNC_COLLS) {
    for (const k of Object.keys(state[c])) {
      next[c][k] = c === 'companies' ? { id: k, del: true, u: now } : c === 'hours' ? { h: 0, tags: [], u: now } : { u: now };
      next.pending[`${c}\t${k}`] = true;
    }
  }
  state = next;
  save();
}
