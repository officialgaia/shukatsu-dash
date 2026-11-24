// 日付まわりと小さな道具。日付はすべて端末のローカル時刻（日本時間想定）の 'YYYY-MM-DD' 文字列で扱う。

export const pad = (n) => String(n).padStart(2, '0');

export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function today() {
  // ?today=2027-02-23 で日付を差し替えて表示確認できる（開発用）
  const q = new URLSearchParams(location.search).get('today');
  if (q && /^\d{4}-\d{2}-\d{2}$/.test(q)) return q;
  return ymd(new Date());
}

export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function daysBetween(a, b) {
  // b - a（日数）
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}

export function mondayOf(s) {
  const d = parseYmd(s);
  const dow = (d.getDay() + 6) % 7; // 月=0 … 日=6
  d.setDate(d.getDate() - dow);
  return ymd(d);
}

export function weekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
export function dow(s) {
  return DOW[parseYmd(s).getDay()];
}
export function isSunday(s) {
  return parseYmd(s).getDay() === 0;
}

export function md(s) {
  const d = parseYmd(s);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function mdDow(s) {
  return `${md(s)}(${dow(s)})`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtH(h) {
  return (Math.round(h * 10) / 10).toString();
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- plan の解釈 ----

/** 今日が属する週（plan.weeks の要素 or afterExam）を返す。 */
export function currentWeek(plan, day) {
  const mon = mondayOf(day);
  const w = plan.weeks.find((x) => x.start === mon);
  if (w) return { ...w, kind: 'week' };
  if (plan.afterExam && day >= plan.afterExam.start) return { ...plan.afterExam, kind: 'after' };
  if (day < plan.weeks[0].start) return { ...plan.weeks[0], kind: 'upcoming' };
  // 予定のすき間（通常は起きない）：直前の週
  const prev = [...plan.weeks].reverse().find((x) => x.start <= day);
  return prev ? { ...prev, kind: 'week' } : null;
}

/** 週の開始日（月曜）に対応する勉強時間の目標。なければ null。 */
export function targetFor(plan, monday) {
  const p = plan.studyTargets.periods.find((x) => monday >= x.from && monday <= x.to);
  return p ? { ...p, floor: plan.studyTargets.floor.hours } : null;
}

export function activeDecisions(plan, day) {
  return (plan.decisionPoints || []).filter((d) => day >= d.from && day <= d.to);
}

export function weekItemId(start, side, i) {
  return `${start}:${side}:${i}`;
}
