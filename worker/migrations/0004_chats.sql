-- AIタブの会話（アプリを操作できるAI）
--   messages : Claude に渡す形の履歴（ツールの呼び出しと結果も含む）
--   display  : 画面に出す形（[{r:'user'|'ai'|'act', t:'...'}]）
--   context  : 会話を始めた時点のデータ（会話中は固定。キャッシュを効かせるため）
CREATE TABLE IF NOT EXISTS chats (
  id       TEXT PRIMARY KEY,
  day      TEXT NOT NULL,
  created  INTEGER NOT NULL,
  updated  INTEGER NOT NULL,
  title    TEXT,
  context  TEXT NOT NULL,
  messages TEXT NOT NULL,
  display  TEXT NOT NULL,
  turns    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chats_updated ON chats (updated);
