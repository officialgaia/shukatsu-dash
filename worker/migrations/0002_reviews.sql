-- 日曜の振り返り（AIコーチ）の履歴
--   week     : 振り返った週の月曜日 'YYYY-MM-DD'
--   context  : 開始時にまとめた今週のデータ（会話中は固定）
--   messages : Claude とのやりとり（API にそのまま渡す形の JSON 配列）
--   turns    : 利用者が送った回数（上限の判定に使う）
--   summary  : 最後のまとめの全文
--   next     : 来週やること3つ（JSON 配列）
--   status   : 'open'（会話中）| 'done'（保存済み）
CREATE TABLE IF NOT EXISTS reviews (
  id       TEXT PRIMARY KEY,
  week     TEXT NOT NULL,
  created  INTEGER NOT NULL,
  updated  INTEGER NOT NULL,
  context  TEXT NOT NULL,
  messages TEXT NOT NULL,
  turns    INTEGER NOT NULL DEFAULT 0,
  summary  TEXT,
  next     TEXT,
  status   TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS reviews_week ON reviews (week);
CREATE INDEX IF NOT EXISTS reviews_created ON reviews (created);
