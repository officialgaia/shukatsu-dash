# 就活ボード（都庁×民間）

都庁試験と民間の就活を並行するための、スマホ用ダッシュボード（PWA）です。

- `web/` … 画面（HTML/CSS/JS のみ。ビルド不要）。GitHub Pages で公開
- `worker/` … Cloudflare Workers（データ同期・AIコーチ・プッシュ通知）

## 進み具合

| 段階 | 内容 | 状態 |
|---|---|---|
| M1 | 画面（ホーム・記録・週チェック・会社・方針）、端末内に保存 | ✅ できた |
| M2 | Worker＋D1 で保存と同期、アクセストークン認証 | ✅ できた |
| M3 | AIコーチ（日曜の振り返り） | ✅ できた |
| M4 | PWA の仕上げとプッシュ通知 | ✅ できた |

---

## 予定やルールを直すとき

予定・目標・方針は **`web/data/plan.json` の1か所** にまとめてあります。コードを触る必要はありません。

- **試験日**：`"examDate": "2027-04-18"` を正式な日付に変える（残り日数・目標期間の表示に使われます）
- **週ごとにやること**：`weeks` の各週の `tocho`（都庁）と `minkan`（民間）。週の `start` は必ず **月曜日** の日付にする
  - チェック状態は「週の開始日＋何番目の項目か」で覚えています。項目の **順番を入れ替えると、チェックがずれます**。文言だけ直す・末尾に足す、なら大丈夫です
- **勉強時間の目標**：`studyTargets`
- **判断ポイントのバナー**：`decisionPoints` の `from`〜`to` の間、ホームの一番上に出ます
- **1日の型** の未記入部分：`dayTemplates` の `todo` を消して `slots` に書き足す

直したら GitHub に push すれば、数分で公開中のアプリにも反映されます（アプリは毎回最新の plan.json を取りに行きます）。

---

## 手元で動かす（パソコン）

Python が入っていれば、そのまま動きます。

```bash
python3 -m http.server 8787 -d web
```

ブラウザで http://localhost:8787 を開きます。

- 日付を変えて表示を確かめたいとき：`http://localhost:8787/?today=2027-02-23#/home` のように `?today=` を付ける
- ファイルを `index.html` として直接ダブルクリックで開くと動きません（plan.json を読めないため）。必ず上のコマンドで開いてください

---

## GitHub Pages で公開する

1. GitHub で新しいリポジトリを作り、このフォルダの中身を push する（ブランチ名は `main`）
2. リポジトリの **Settings → Pages** を開き、**Source** を **GitHub Actions** にする
3. `main` に push すると `.github/workflows/pages.yml` が動き、`web/` フォルダが公開される
   - 進み具合はリポジトリの **Actions** タブで見られる
4. 公開 URL は `https://<ユーザー名>.github.io/<リポジトリ名>/`

> **注意（公開範囲）**：無料プランの GitHub Pages は **公開リポジトリ** が前提です。`plan.json`（予定・方針・最初の会社4社）は誰でも見られる状態になります。会社リストやメモ・記録は plan.json ではなく端末（M2 以降は Cloudflare D1）に保存されるので公開されません。

---

## スマホのホーム画面に追加する

### Android（Chrome）
1. Chrome で公開 URL を開く
2. 右上の「︙」→「ホーム画面に追加」（または「アプリをインストール」）
3. ホーム画面のアイコンから開く

### iPhone（Safari）
1. **Safari** で公開 URL を開く（Chrome アプリなど他のブラウザでは不可）
2. 下の共有ボタン（□に↑）→「ホーム画面に追加」
3. ホーム画面のアイコンから開く

> **iPhone の注意**：ホーム画面のアプリと Safari は **保存場所が別** です。アクセストークンは **ホーム画面に追加したアプリの方** で入力してください。

---

## Cloudflare（Worker＋D1）のセットアップ

データをクラウドに保存し、端末をまたいで同期するための部分です。無料プランで動きます。
コマンドはすべて `worker/` フォルダで実行します。Node.js（v20 以上）が必要です。

### 1. Cloudflare アカウントを作る
1. https://dash.cloudflare.com/sign-up でアカウントを作る（無料プランで OK、クレジットカード不要）
2. メールアドレスの確認を済ませる

### 2. wrangler を準備してログイン
```bash
cd worker
```
```bash
npm install
```
```bash
npx wrangler login
```
ブラウザが開くので「Allow」を押します。

### 3. D1 データベースを作る
```bash
npx wrangler d1 create shukatsu-dash
```
表示された `database_id` を、`worker/wrangler.toml` の `REPLACE_WITH_YOUR_D1_DATABASE_ID` と置き換えます（ID は秘密ではないのでコミットして大丈夫です）。

続けてテーブルを作ります。
```bash
npm run db:migrate:remote
```

### 4. 許可するオリジン（CORS）を設定
`worker/wrangler.toml` の `ALLOWED_ORIGINS` を、GitHub Pages のオリジンに変えます。

- 例：公開 URL が `https://taro.github.io/shukatsu/` なら、オリジンは **`https://taro.github.io`**（後ろのパスは付けない）

### 5. アクセストークンを作って secret に登録
長いランダムな文字列を作ります（Mac のターミナル）。
```bash
openssl rand -base64 33 | tr '+/' '-_'
```
出てきた文字列をコピーして、Worker の secret に登録します（貼り付けを求められます）。
```bash
npx wrangler secret put ACCESS_TOKEN
```
- この文字列は **パスワードと同じ扱い** です。リポジトリやチャットに貼らず、パスワード管理アプリなどに保存してください
- 32文字未満だと Worker はすべての通信を拒否します（設定漏れ対策）

### 6. デプロイ
```bash
npm run deploy
```
最後に表示される `https://shukatsu-dash.<アカウント名>.workers.dev` が Worker の URL です。

### 7. アプリに Worker の URL を書く
`web/data/config.json` の `apiBase` に、6 の URL を書いて push します（URL は秘密ではありません）。
```json
{ "apiBase": "https://shukatsu-dash.<アカウント名>.workers.dev" }
```

### 8. スマホでトークンを入力
1. ホーム画面に追加したアプリを開く
2. 右上の歯車 →「同期」の「アクセストークン」に 5 の文字列を貼り付けて「接続する」
3. 右上の点が **緑** になれば同期済み（青の点滅＝同期中、灰＝オフラインか未接続、赤＝エラー）

2台目以降の端末も同じトークンを入れるだけで、データがそろいます。

### トークンを変えたいとき（漏れたかもしれないとき）
5 をもう一度実行して新しい値で上書きすると、古いトークンはすぐ使えなくなります。各端末で「接続を解除」→新しいトークンで接続し直してください。データは消えません。

### 同期のしくみ（メモ）
- まず端末に保存し、1.5秒後にまとめて Worker へ送ります。アプリを開いたとき・画面に戻ったとき・ネットにつながったときにも同期します
- オフラインでも記録できます。つながったときに送られます
- 同じ項目を2台で変えたときは、**あとで変更した方** が残ります
- D1 には `records` という表が1つあり、勉強時間・毎日のチェック・週チェック・会社をまとめて保存しています（`worker/migrations/0001_init.sql`）

---

## AIコーチ（日曜の振り返り）のセットアップ

Claude API を使います。**API は使った分だけ料金がかかります**（無料枠はありません）。

### 1. API キーを作る
1. https://console.anthropic.com にサインアップ／ログイン
2. **Billing** で支払い方法を登録し、クレジットを少し購入する（最初は 5 ドル程度で十分）
3. 使いすぎ防止に、**Limits** で月の上限額（例：5 ドル）を設定しておくと安心
4. **API Keys** → **Create Key** でキーを作り、コピーする（`sk-ant-...` で始まる文字列。画面を閉じると二度と表示されない）

### 2. Worker に登録してデプロイ
`worker/` フォルダで：
```bash
npx wrangler secret put ANTHROPIC_API_KEY
```
（コピーしたキーを貼り付け）

振り返りの表を作ってから、デプロイし直します。
```bash
npm run db:migrate:remote
```
```bash
npm run deploy
```

### 3. 使い方
- **日曜** になると、ホームの一番上に「AIと振り返る」ボタンが出ます
- 日曜以外も使いたいときは、設定 →「日曜以外もボタンを出す」をオン（「先週」を選んで振り返ることもできます）
- AI は次の順に1つずつ聞きます：①数的処理を毎日やれたか ②TACの講義が予定どおりか ③新しい会社を1社探す
- 最後に「まとめて保存」を押すと「来週やること3つ」が履歴に残り、翌週のホームに表示されます

### 4. 設定を変えたいとき（`worker/wrangler.toml` の `[vars]`）
| 項目 | 初期値 | 意味 |
|---|---|---|
| `COACH_MODEL` | `claude-sonnet-5-5` | 使うモデル |
| `COACH_EFFORT` | `low` | 考える深さ（`low` / `medium` / `high`）。高いほど丁寧だが料金も上がる |
| `COACH_MAX_TURNS` | `10` | 1回の振り返りで送れる回数の上限 |
| `COACH_DAILY_LIMIT` | `3` | 1日に始められる振り返りの回数 |

変えたら `npm run deploy` で反映されます。

### 料金の目安
1回の振り返り（5往復程度）で数円〜十数円ほどです（2026年11月時点の Sonnet 5.5 の料金 $2 / $10 per 100万トークンで試算。正確な額は Console の **Usage** で確認してください）。毎週1回なら月に数十円程度の見込みです。

### しくみ（メモ）
- AI に渡すのは、その週の勉強時間・毎日のチェック・週チェック・会社リスト・今週と来週の計画・前回の「来週やること」です。Worker が D1 から集めます
- API キーは Worker の secret にだけ置かれ、アプリ（ブラウザ）には一切送られません
- 会話は D1 の `reviews` 表に保存されます
- 安全上の理由で AI が答えを控えた場合に、別のモデルで自動的に続ける設定（サーバー側フォールバック）を有効にしています

---

## プッシュ通知のセットアップ

毎朝（初期値 7:00）に今週のテーマを、日曜（初期値 20:00）に振り返りの案内を送ります。無料プランで動きます。

### 1. VAPID 鍵を作る（1回だけ）
VAPID 鍵は「この Worker から送った通知です」と証明するための鍵ペアです。`worker/` フォルダで：
```bash
npm run vapid
```
2つの文字列が表示されます。
- **PUBLIC**：`worker/wrangler.toml` の `VAPID_PUBLIC_KEY = ""` の中に貼る（公開されても大丈夫）
- **PRIVATE**：次のコマンドで secret に登録する（**人に見せない・リポジトリに入れない**）
```bash
npx wrangler secret put VAPID_PRIVATE_KEY
```
> 鍵を作り直すと、登録済みの端末はすべて通知を受け取れなくなります。その場合は各端末で通知をオンにし直してください。

### 2. wrangler.toml の残りを書く
- `VAPID_SUBJECT`：GitHub Pages の公開 URL（例 `https://taro.github.io`）。通知サービスが送信元の連絡先として使います
- `PLAN_URL`：公開中の plan.json の URL（例 `https://taro.github.io/shukatsu/data/plan.json`）。通知の文面（今週のテーマ・判断ポイント）をここから作ります

### 3. 表を作ってデプロイ
```bash
npm run db:migrate:remote
```
```bash
npm run deploy
```
`[triggers]` の `crons = ["*/15 * * * *"]` により、Worker が15分ごとに起動します。

> **時刻について**：Cron の時刻は UTC（日本時間 −9時間）で書きますが、このアプリでは「15分ごとに起きて、日本時間の設定時刻を過ぎていたら送る」ようにしているので、UTC に換算する必要はありません。通知の時刻はアプリの設定画面で15分刻みで変えられます。同じ日に二重には送りません。

### 4. スマホで通知をオンにする
**Android（Chrome）**
1. ホーム画面に追加したアプリを開く
2. 設定 →「通知」→「この端末で通知を受け取る」→ 許可を求められたら「許可」
3. 「テスト通知を送る」→ 数秒〜数十秒で通知が届けば OK

**iPhone（iOS 16.4 以上）**
1. **Safari** で開き、共有ボタン →「ホーム画面に追加」
2. **ホーム画面のアイコンから** 開く（Safari のままでは通知を許可できません）
3. 設定でトークンを入力 →「通知」→「この端末で通知を受け取る」→「許可」
4. 「テスト通知を送る」で確認

通知の時刻とオン・オフは、設定画面の「送る時刻」で変えられます（すべての端末に共通）。

### Android で実際に届くことを確かめる手順
1. 上の 4 で「テスト通知を送る」が届くことを確認する
2. 設定の「送る時刻」で **毎朝の通知** を、今から15〜30分後の時刻にする（例：今が 21:05 なら 21:15 か 21:30）
3. アプリを閉じ、スマホをスリープにして待つ
4. 設定した時刻から15分以内に「都庁まであと◯日」の通知が届けば OK
5. 通知をタップすると、アプリのホームが開くことを確認する
6. 確認できたら、時刻を 07:00 に戻す

届かないときは：
- Cloudflare のダッシュボード → Workers → shukatsu-dash → **Logs**（または `npx wrangler tail`）で `scheduled` や `push failed` を確認
- 設定の「通知」に「登録済みの端末 0台」と出ていたら、もう一度「通知を受け取る」を押す
- Android の「設定」→ アプリ → Chrome（または就活ボード）→ 通知 がオンか確認。省電力設定で通知が遅れることがあります
- 「文面の見本」に「plan.json を読めていない」と出ていたら `PLAN_URL` を確認

---

## Worker を手元で動かす（開発用）

```bash
cd worker
```
```bash
cp .dev.vars.example .dev.vars
```
`.dev.vars` の `ACCESS_TOKEN` をランダムな文字列に書き換えてから：
```bash
npm run db:migrate:local
```
```bash
npm run dev
```
Worker が http://localhost:8788 で動きます。

- 通知の送信は `npx wrangler dev --port 8788 --test-scheduled` で起動し、`http://localhost:8788/__scheduled?cron=*/15+*+*+*+*` を開くと Cron を手動で動かせます
- `npm test` で、通知の暗号化（参照実装で復号できるか）・VAPID 署名・文面・日本時間の計算を確認できます

`.dev.vars` の `COACH_MOCK=1` のままなら、AIコーチは Claude を呼ばずに決まった返事を返します（料金はかかりません）。本物で試すときは `COACH_MOCK=0` にして `ANTHROPIC_API_KEY` を入れてください。画面側（`python3 -m http.server 8787 -d web`）を開き、設定の「Worker の URL」に `http://127.0.0.1:8788`、トークンに `.dev.vars` の値を入れて接続します。

---

## データのバックアップ

右上の歯車 →「書き出す」で JSON ファイルに保存でき、「読み込む」で戻せます。読み込んだ内容は同期でほかの端末にも反映されます。

---

## secret の一覧（すべて `npx wrangler secret put <名前>` で登録）

| 名前 | 中身 | 段階 |
|---|---|---|
| `ACCESS_TOKEN` | アプリに入力する長いランダムな文字列 | M2 |
| `ANTHROPIC_API_KEY` | Claude API のキー | M3 |
| `VAPID_PRIVATE_KEY` | プッシュ通知の秘密鍵 | M4 |

秘密情報（APIキー、VAPID 秘密鍵、アクセストークン）は **絶対にリポジトリへ入れません**。`.dev.vars` は `.gitignore` 済みで、本番の値は `wrangler secret put` で設定します。
