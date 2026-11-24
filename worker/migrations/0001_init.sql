-- 同期するデータ（勉強時間・毎日のチェック・週チェック・会社）を1つの表にまとめる。
--   coll : 'daily' | 'hours' | 'weekChecks' | 'companies'
--   key  : 日付・項目ID・会社ID など
--   data : レコード本体（JSON 文字列）
--   u    : 端末で更新した時刻（ミリ秒）。新しい方が勝つ
--   s    : サーバーが受け取った時刻（ミリ秒）。差分取得に使う
CREATE TABLE IF NOT EXISTS records (
  coll TEXT NOT NULL,
  key  TEXT NOT NULL,
  data TEXT NOT NULL,
  u    INTEGER NOT NULL,
  s    INTEGER NOT NULL,
  PRIMARY KEY (coll, key)
);
CREATE INDEX IF NOT EXISTS records_s ON records (s);
