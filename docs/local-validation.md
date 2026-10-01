# ローカル検証とfixture再利用

本番デプロイは不要です。通常のテストは `tests/no-network.ts` で外部fetchを禁止し、AI/Discordはfakeに差し替えます。実AIは明示的なevalコマンドだけが呼びます。

| Level | コマンド | 対象 / 外部接続 |
|---|---|---|
| 1 Pure local | `pnpm test:station` | StaticRailwayRepository、補正、same-line、両方向alignment、graph、単発・top-5 rescue、merge、意味構造、表示、deadline/retry。Node Vitest。外部APIなし |
| 2 Fixture | `pnpm eval:station fixtures/railway/B-meitetsu` / `pnpm eval:railway` | 保存済みtranscription / analysisから補正とGemini #2の入力材料を生成。外部APIなし |
| 3 Workers AI | `pnpm eval:whisper audio.mp3 --out fixtures/captured/sample` | `@cf/openai/whisper-large-v3-turbo`実API。圧縮音声とAbortSignal、10–14分のbudget。MP3 decodeエラー時だけframes再送。PCM/WAV変換なし |
| 3 Gemini #1 | `pnpm eval:gemini-analysis fixtures/captured/sample` | 実APIの解析・意味構造・mention・request/responseを保存 |
| 3 Gemini #2 | `pnpm eval:normalize fixtures/captured/sample` | 静的補正材料＋保存済み解析を使い、実APIの再構成結果を保存 |
| 3 Full | `pnpm eval:full audio.mp3 --out fixtures/captured/sample` | Whisper→Gemini #1→補正→Gemini #2。D1/Discordは呼ばない |
| 4 Worker | `pnpm verify:local` | fresh temp local D1に全migration、master削除、FKチェック、wrangler dev `/health`。実AIなし |
| 4 Queue/Discord | `pnpm test` | ローカルworkerd D1でpublic/demoのQueue consumer、fake AI、Discord callback、clip保存、Queue retryのcheckpoint再利用 |

その他: `pnpm typecheck`、`pnpm generate:railway-data`、`pnpm benchmark:static`、`pnpm eval:accuracy fixtures/captured`、`pnpm deploy:dry-run`。

実AIを使う手動のローカルWorker起動は `pnpm db:migrate:local` → `pnpm dev --port 8787` → `curl http://localhost:8787/health`。Workers AI bindingは `remote: true`、D1・Queueはlocalです。`wrangler dev --local` はremote bindingも無効化するため、実音声処理では付けないでください。起動ログが `env.AI: remote` であることを確認します。`verify:local` は外部AIを呼ばないhealth/migration検証なので意図的に `--local` を使い、通常のローカルDBと別の一時storageを使います。本番migrationやdeployを実行しません。

## 実APIの設定

`.dev.vars` または環境変数に `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`（Workers AIの実行権限）、`GEMINI_API_KEY` を設定してください。Geminiモデルは `GEMINI_MODEL`、既知の音声時間は `AUDIO_DURATION_SECS` で指定できます。secretをfixture/commitへ含めません。Gemini diagnosticsのAPI keyはredact済みです。

Cloudflare REST adapterは[公式REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)を利用します。APIの料金・認証・実モデルの音声decode/品質確認はLevel 3が必要です。通常テストはそれらに接続しません。

保存済みraw/analysis/normalizedを再取得して上書きしないよう、実API呼び出し前にoutput衝突を確認します。再実行は新しい `--out` フォルダを指定してください。analysis/normalizeは入力fixtureをそこへコピーします。`correction.json` は静的データから再生成できる派生artifactです。

## Fixture

現在の `fixtures/railway/` は9ケース:

- A-exact: 少数駅、同一路線
- B-meitetsu: 神話口／福岐／千田竹豊／上／奈良／千田半田
- C-long: 20 mentionの長い案内
- D-transfer: 複数路線
- E-ambiguous: 安全な未解決
- F-multilingual: 日本語とWakuda Onsenの英語
- G-injection: role / delimiter / JSONを含む音声テキスト
- H-single: 安雪の単発
- I-repeated: 同じraw mentionの複数occurrence/sequence

これらは利用者が提示した誤認識例に基づく**synthetic reproduction**です。実音声から取得したWhisper出力とは主張しません。実音声と認証情報がworkspaceにないため、実API測定は未実施です。

各ケースは `transcription.json`、`analysis.json`、`expected.json` を持ちます。`eval:station <fixture> --save` でraw/semantic/correction/normalization promptを含む `correction.json` を生成できます。実API取得ケースは `fixtures/captured/<case>/` にtranscription、Whisper response、analysis、normalizedを保存します。以後の駅補正再現に実APIは不要です。

## 精度評価

100–300件程度の実音声ケースを同じ形式で追加できます。各caseに人手の `labels.json` を追加:

```json
{"mentions":[{"mentionId":"mention:0:2","sourceText":"安雪","expectedText":"野洲","requiresCorrection":true,"hasCandidates":true}]}
```

`normalized.json` のentities/sourceMentionIdからprecision/recall/false correction/unresolvedを計算します。これは**IDで対応できるentityの評価**です。ID欠落や自由な文章再構成でentity自体が漏れたケースは人手確認も必要で、全文章の事実精度とは区別してください。ラベルなしの指標はnullとし、実測値を作りません。

precision = 正しい変更 / 実施した変更、recall = 正しい変更 / 要補正mention、false correction rate = 元々正しいmentionの誤変更 / 元々正しいmention、unresolved rate = 候補あり・要補正・未変更 / 候補ありmention。

## 環境依存で残る確認

本番固有のCPU課金、128MiBのピークメモリ、cold start、Queueの実再配信、Discordの権限/レート制限/15分callback期限はローカルで完全には再現できません。補正ロジックの検証やWorker起動に本番デプロイは必要ありません。実音声のdecodeと実Gemini品質はローカルCLIから確認できます。
