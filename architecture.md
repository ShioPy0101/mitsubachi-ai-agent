# Architecture

## Scope and invariants

This Worker analyzes public-transit announcements posted as Discord attachments. Discord is the canonical audio store. D1 stores the stable Discord tuple `(guild_id, channel_id, message_id, attachment_id)`, analysis records, and usage accounting; it never stores audio blobs or treats an expiring CDN URL as identity.

The Worker exposes a Hono HTTP endpoint for Discord Interactions and consumes Cloudflare Queue messages. There is no Discord Gateway connection, Cron scanner, or separate server.

External values cross runtime-validation adapters before reaching domain code. Generated Cloudflare bindings in `worker-configuration.d.ts` are the environment source of truth. Application code must not introduce a handwritten `Env` interface or `any`.

## Flow

1. `/platform-ai-agent audio:<attachment>` validates the interaction signature and attachment, inserts a job idempotently by Interaction ID, enqueues `{ jobId }`, and immediately returns a public deferred ACK. Progress and the final result update the same channel-visible message.
2. `/platform-search query:<text>` performs a bounded repository search and returns an immediate ephemeral response.
3. The Queue consumer reloads the interaction attachment reference from its short-lived table, downloads it with a configured byte cap, transcribes it through Workers AI, checkpoints the raw transcription for retry, generates station candidates from D1, parses metadata through Gemini structured JSON plus Zod, stores the clip, and edits the Interaction response with the normalized transcription and renamed audio attachment.
4. Whisper success followed by Gemini failure is stored as `partial`; other terminal failures are `failed` after retry policy is exhausted.

## Decisions and technical risks

- **Interaction deadline:** signatures and request shape are checked synchronously, then the command receives Discord deferred channel-message ACK (`type: 5`). Heavy work happens in the queue. If Queue insertion fails, the inserted job is deleted with its temporary secrets and Discord receives an immediate retryable error response.
- **Attachment durability:** Slash-command CDN URLs can expire and cannot be reconstructed from an Interaction ID. The command therefore queues immediately; an expired or unavailable input becomes `failed` with a safe re-run instruction.
- **Slash attachments:** an attachment command invocation does not expose a durable source message ID. Its Interaction ID plus attachment ID is the stable identity. The received CDN URL and follow-up token live in dedicated short-lived tables, are excluded from search/domain metadata, and are deleted after terminal notification or expiry cleanup. If queue delay exceeds Discord's webhook-token lifetime and a channel is available, the bot falls back to a channel message.
- **Audio limits/chunking:** the MVP passes one bounded `ArrayBuffer` to Whisper. `TranscriptionService` supports chunk arrays, but byte splitting is intentionally not implemented because arbitrary compressed-audio byte chunks are invalid. Real long-audio chunking needs a Workers-compatible media segmenter or upstream segmentation.
- **Multilingual audio:** Whisper language detection is automatic and receives multilingual public-transit context through `initial_prompt`; it still runs only once per audio file. Gemini preserves Japanese, English, Chinese, Korean, and other language blocks in their original language and order; equivalent blocks in different languages are not deduplicated.
- **Gemini:** Gemini is only a metadata parser/normalizer. It receives a JSON schema, a non-inference prompt, and its JSON is parsed with Zod. Filenames are deterministic domain output.
- **Retry checkpoint:** A successful Whisper transcription is stored on the job. Transient Gemini or D1 failures resume from that text instead of paying for and waiting on Whisper again. Audio bytes remain ephemeral and are re-downloaded only when a retried job needs to attach the result.
- **Reprocessing:** the normal insert path is idempotent. Explicit reprocess is not exposed in the MVP; when added it must create a distinct attempt record rather than weaken the unique Discord attachment constraint.
- **Search:** MVP uses escaped `LIKE` predicates behind `ClipsRepository`; moving to FTS5 does not affect command/domain code.
- **Source links:** Slash-command uploads have no durable Discord message URL. Search can return analysis records and generated names, but cannot offer a jump link to an invocation message. A future message-ingestion feature must add its own durable message source model.
- **Station master:** `data/stations.csv` is the source of truth. `pnpm stations:sql` produces idempotent D1 upserts; the Worker never parses the CSV. D1 first narrows candidates and traverses the station graph across adjacent and same-name transfer nodes. TypeScript performs weighted name/kana/context scoring. Only the top twelve distinct station names reach Gemini, and candidate-external station output is discarded by `StationResolver`.
- **Secrets:** `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, and `GEMINI_API_KEY` are Wrangler secrets and therefore absent from `vars`.

## Status transitions

`pending -> queued -> transcribing -> Gemini safety/domain check -> metadata_extracting -> completed`

Whisperの結果は、Geminiの厳格なSafety Settingsと公共交通案内のドメイン判定を通過するまで保存しない。Safety Block、公共交通以外、判定不能、Gemini障害はfail-closedとし、本文をD1へ保存せず後段処理を中断する。

Discord guildは既定で無効。`DISCORD_CONTROL_USER_IDS` に登録されたユーザーがサーバー内で `/platform-ai-agent-allow` を実行したguildだけが音声解析と検索を利用でき、`/platform-ai-agent-deny` で停止できる。

Allowed terminal outcomes are `partial` and `failed`.

## Operational setup

Replace the placeholder D1 database ID, create the queue and DLQ, configure secrets, set `SCAN_CHANNELS` to a JSON array of `{ guildId, channelId }`, apply migrations, register Discord commands, then deploy. Command registration is a deployment-time REST operation, not Worker startup behavior.
