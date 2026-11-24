-- プッシュ通知の購読（端末ごと）
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  p256dh   TEXT NOT NULL,
  auth     TEXT NOT NULL,
  ua       TEXT,
  created  INTEGER NOT NULL,
  last_ok  INTEGER,
  fails    INTEGER NOT NULL DEFAULT 0
);
-- 小さな設定（通知の時刻とオン・オフなど）
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 同じ日に二重に送らないための記録
CREATE TABLE IF NOT EXISTS notify_log (
  kind    TEXT NOT NULL,
  day     TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (kind, day)
);
