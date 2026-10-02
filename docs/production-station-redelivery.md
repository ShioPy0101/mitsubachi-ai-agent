# 本番の駅探索中の再配送調査

2026-10-02 の調査。原因は未確定。デプロイ・設定変更・本番書き込みは実施していない。

## 確認した状態

- 本番 D1 の直近 2 件は Queue attempt が 6。最後の保存済み stage は `station_candidates_sequences`、failure code と error message は空だった。
- 1 件の checkpoint は speech と analysis を保持し、correction は未保存だった。
- 保存済み raw transcription と analysis をローカルの実際の `StationCorrectionEngine` / static repository に渡すと、13 mentions の探索は約 1,710 ms で完了した。外部 AI は呼んでいない。
- ローカルの station-related D1 query count は 0。graph search は 3 回、alignment comparison は合計 6,789 回だった。
- 短時間の本番 tail では cron の成功しか捕捉できず、Queue 実行の終了 outcome は未取得。

ローカル測定は Node 上の結果であり、Cloudflare Worker の CPU・memory・終了理由を示すものではない。CPU 超過や memory 超過と断定しない。保存済み本番音声由来のデータは一時ファイルでのみ使用し、リポジトリへ追加していない。

## 再配送時の追加ログ

`audio_job_redelivered` を、次の attempt が前回の stage を上書きする前に記録する。

- job / Queue message ID、attempt
- previous status、stage、stage started at
- previous failure code / error message
- transcription checkpoint の有無、deadline
- interruption cause: `unknown`

既存の job 読み取りを使うため、追加 D1 query はない。プロバイダー出力や raw transcription はログへ出さない。これは再配送の観測改善であり、本番の中断原因の解消を保証する修正ではない。

`transcription_provenance` の monitor 表示は「保存済み文字起こし・segment情報の確認」とする。

## 検証

```bash
npm run typecheck
./node_modules/.bin/vitest run tests/pipeline.integration.test.ts tests/jobs.test.ts tests/job-monitor.test.ts
```

型チェック成功、23 tests 成功。downstream retry で Whisper を再実行せず、前回 `gemini_normalization` の状態と checkpoint の存在が再配送ログに残ることも検証した。

## 次に必要な証拠

同じ音声の Queue 実行中に `npx wrangler tail --format json` を取得し、アプリの最後の stage ログとプラットフォームの終了 outcome を対応させる。結果に応じて原因を修正する。現時点では route / alignment の閾値や Worker CPU limit を推測で変更しない。
