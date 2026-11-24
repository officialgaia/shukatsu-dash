// 日付の道具（Worker は UTC で動くので、日本時間はここで計算する）
export const JST_OFFSET_MS = 9 * 3600000;
export const DOW = ['日', '月', '火', '水', '木', '金', '土'];

export function parse(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
export function fmt(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
export function addDays(s, n) {
  return fmt(parse(s) + n * 86400000);
}
export function dowOf(s) {
  return new Date(parse(s)).getUTCDay();
}
export function daysBetween(a, b) {
  return Math.round((parse(b) - parse(a)) / 86400000);
}
export function md(s) {
  const [, m, d] = s.split('-').map(Number);
  return `${m}/${d}`;
}
export function mondayOf(s) {
  return addDays(s, -((dowOf(s) + 6) % 7));
}
/** 日本時間で今日の 0:00 を表す UTC ミリ秒 */
export function jstDayStartMs(now) {
  return Math.floor((now + JST_OFFSET_MS) / 86400000) * 86400000 - JST_OFFSET_MS;
}
/** 日本時間の { day: 'YYYY-MM-DD', minutes: 0:00 からの分, dow } */
export function jstNow(now = Date.now()) {
  const t = new Date(now + JST_OFFSET_MS);
  const day = t.toISOString().slice(0, 10);
  return { day, minutes: t.getUTCHours() * 60 + t.getUTCMinutes(), dow: t.getUTCDay() };
}
