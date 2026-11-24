// 通知の文面と日本時間の計算の確認（web/data/plan.json を使う）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { morningMessage, sundayMessage } from '../src/notify.js';
import { jstNow } from '../src/dates.js';

const plan = JSON.parse(readFileSync(new URL('../../web/data/plan.json', import.meta.url)));

test('朝の通知：今週のテーマと民間を1〜2行で', () => {
  const m = morningMessage(plan, '2026-11-24');
  assert.equal(m.title, '都庁まであと145日');
  assert.equal(m.body, '今週：判断推理・憲法／民間：1社追加・早期選考4社の日程確認。今日も数的処理から');
  assert.equal(m.url, './#/home');
});

test('朝の通知：判断ポイントの週は先頭に入る', () => {
  const m = morningMessage(plan, '2027-02-23');
  assert.match(m.body, /^【判断の週】本命3科目/);
  assert.match(m.body, /今日も数的処理から$/);
});

test('朝の通知：民間がない週・試験当日・試験後', () => {
  assert.equal(morningMessage(plan, '2027-04-06').body, '今週：本命3科目と時事の最終確認。今日も数的処理から');
  assert.equal(morningMessage(plan, '2027-04-18').title, '今日が本番。体調第一で');
  assert.match(morningMessage(plan, '2027-04-20').body, /民間を本格再開/);
});

test('plan が読めないときも送れる', () => {
  assert.deepEqual(morningMessage(null, '2026-11-24'), { title: '就活ボード', body: '今日も数的処理から', url: './#/home' });
});

test('日曜の通知：振り返りへ誘導し、来週の判断ポイントを添える', () => {
  const m = sundayMessage(plan, '2027-02-21');
  assert.equal(m.url, './#/review');
  assert.match(m.body, /来週は【判断の週】/);
  assert.match(m.body, /来週（2\/22〜）/);
});

test('日本時間の計算（UTC 22:00 = 日本の翌朝 7:00）', () => {
  const r = jstNow(Date.UTC(2026, 10, 23, 22, 0)); // 2026-11-23 22:00 UTC
  assert.deepEqual(r, { day: '2026-11-24', minutes: 7 * 60, dow: 2 });
  const s = jstNow(Date.UTC(2026, 10, 29, 11, 0)); // 2026-11-29 11:00 UTC = 日曜 20:00 JST
  assert.deepEqual(s, { day: '2026-11-29', minutes: 20 * 60, dow: 0 });
});
