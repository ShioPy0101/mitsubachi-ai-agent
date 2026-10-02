# 本番の駅探索中の再配送調査

2026-10-02 の調査。追加の本番実行で CPU 制限超過を捕捉した。デプロイ・設定変更・本番書き込みは実施していない。

## 追加実行で確認した終了理由

監視接続後に送信された新規ジョブの Queue attempt 1〜6 は、すべて `outcome: exceededCpu` だった。最後の stage はすべて `station_candidates_sequences`。

| attempt | CPU time (ms) | wall time (ms) | outcome     |
| ------- | ------------: | -------------: | ----------- |
| 1       |          2050 |          20511 | exceededCpu |
| 2       |            50 |           4862 | exceededCpu |
| 3       |            50 |           4807 | exceededCpu |
| 4       |            50 |           4767 | exceededCpu |
| 5       |            50 |           4552 | exceededCpu |
| 6       |            50 |           5742 | exceededCpu |

これにより、アプリの stage failure ログを経由せず再配送される直接の原因は、Cloudflare の CPU 制限による実行終了と特定できた。Whisper は初回で成功し、その後は保存済み transcription を再利用していた。最終的な stale recovery の deadline 超過は、再配送しても完了できなかった結果。

ローカルの `wrangler.jsonc` に `limits.cpu_ms` はない。実際のプラン・デプロイ済み CPU 設定は未確認で、50 ms という観測値だけから Free / Paid を断定しない。

Paid では明示的な CPU 上限を設定できる。旧 Bundled からの移行で 50 ms が設定されている場合があるとの公式説明もある。ただし現在のアカウントがそのケースかは未確認。

- [Workers pricing / CPU limit](https://developers.cloudflare.com/workers/platform/pricing/)
- [Queue consumer CPU limits](https://developers.cloudflare.com/queues/platform/limits/)

CPU time、stage timeout、job deadline は別概念。stage timeout / deadline の延長や、route alignment の閾値緩和では CPU 制限による終了は解消しない。

## 最初の調査で確認した状態

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

## 最初の調査時点で必要だった証拠

同じ音声の Queue 実行中に `npx wrangler tail --format json` を取得し、アプリの最後の stage ログとプラットフォームの終了 outcome を対応させる。結果に応じて原因を修正する。現時点では route / alignment の閾値や Worker CPU limit を推測で変更しない。

追加実行で終了 outcome は取得済み。次はプランと CPU 上限設定を確認し、必要な実行枠を設定したうえで同じ音声が完了するか再検証する。
