# Architecture

## Scope and invariants

This Worker analyzes public-transit announcements posted as Discord attachments. Discord is the canonical audio store. D1 stores the stable Discord tuple `(guild_id, channel_id, message_id, attachment_id)`, analysis records, and usage accounting; it never stores audio blobs or treats an expiring CDN URL as identity.

The Worker exposes a Hono HTTP endpoint for Discord Interactions and consumes Cloudflare Queue messages. There is no Discord Gateway connection, Cron scanner, or separate server.

External values cross runtime-validation adapters before reaching domain code. Generated Cloudflare bindings in `worker-configuration.d.ts` are the environment source of truth. Application code must not introduce a handwritten `Env` interface or `any`.

## Flow

1. `/platform-ai-agent audio:<attachment>` validates the interaction signature and attachment, inserts a job idempotently by Interaction ID, enqueues `{ jobId }`, and immediately returns a public deferred ACK. Progress and the final result update the same channel-visible message.
2. `/platform-search query:<text>` performs a bounded repository search and returns an immediate ephemeral response.
3. The Queue consumer reloads the interaction attachment reference from its short-lived table, downloads it with a configured byte cap, and transcribes it through Workers AI. Gemini #1 classifies the domain, extracts explicit metadata, and labels verbatim station mentions by semantic role and stop-sequence ID without correcting text. The app checkpoints the safe raw transcription, searches D1 independently for each stop sequence, then Gemini #2 produces a constrained normalized transcription from that structure and those local route hypotheses. The clip is stored and the Interaction response is edited with the normalized transcription and renamed audio attachment.
4. Whisper success followed by either Gemini-stage failure is stored as `partial`; other terminal failures are `failed` after retry policy is exhausted.

## Decisions and technical risks

- **Interaction deadline:** signatures and request shape are checked synchronously, then the command receives Discord deferred channel-message ACK (`type: 5`). Heavy work happens in the queue. If Queue insertion fails, the inserted job is deleted with its temporary secrets and Discord receives an immediate retryable error response.
- **Attachment durability:** Slash-command CDN URLs can expire and cannot be reconstructed from an Interaction ID. The command therefore queues immediately; an expired or unavailable input becomes `failed` with a safe re-run instruction.
- **Slash attachments:** an attachment command invocation does not expose a durable source message ID. Its Interaction ID plus attachment ID is the stable identity. The received CDN URL and follow-up token live in dedicated short-lived tables, are excluded from search/domain metadata, and are deleted after terminal notification or expiry cleanup. If queue delay exceeds Discord's webhook-token lifetime and a channel is available, the bot falls back to a channel message.
- **Audio limits/chunking:** the input is bounded before download. PCM WAV is decoded directly and MP3 is decoded with a compact WebAssembly decoder. Sustained silent intervals produce valid mono PCM WAV chunks, which are transcribed independently and rejoined in time order. Unsupported codecs retain the previous single-request behavior; compressed bytes are never split arbitrarily.
- **Multilingual audio:** Whisper language detection is automatic and receives multilingual public-transit context through `initial_prompt`; it still runs only once per audio file. Gemini preserves Japanese, English, Chinese, Korean, and other language blocks in their original language and order; equivalent blocks in different languages are not deduplicated.
- **Gemini:** Gemini #1 is an analysis-only boundary: it cannot correct text and returns explicit metadata plus verbatim mentions with `destination` / `direction` / `stop` / `service_change_point` roles and sequence IDs. Sequences are classified as `stops`, `direction`, `destination`, or `unknown`; a multi-station `A、B、C方面` phrase remains a direction sequence rather than being mislabeled as confirmed stops. A nearby destination is searched as context for that direction while remaining a distinct semantic sequence. Gemini #2 receives role-separated hypotheses as non-authoritative context and returns a full `normalizedTranscription`, so it can repair grammar, punctuation, repetition, and sentence boundaries. Its prompt applies stricter evidence requirements to proper nouns, and a deterministic edit-distance guard rejects wholesale rewrites. Both calls use JSON schemas and Zod. Filenames remain deterministic domain output.
- **Retry checkpoint:** A successful Whisper transcription is stored on the job. Transient Gemini or D1 failures resume from that text instead of paying for and waiting on Whisper again. Audio bytes remain ephemeral and are re-downloaded only when a retried job needs to attach the result.
- **Reprocessing:** the normal insert path is idempotent. Explicit reprocess is not exposed in the MVP; when added it must create a distinct attempt record rather than weaken the unique Discord attachment constraint.
- **Search:** MVP uses escaped `LIKE` predicates behind `ClipsRepository`; moving to FTS5 does not affect command/domain code.
- **Source links:** Slash-command uploads have no durable Discord message URL. Search can return analysis records and generated names, but cannot offer a jump link to an invocation message. A future message-ingestion feature must add its own durable message source model.
- **Station master:** `data/stations.csv` is the source of truth. `pnpm stations:sql` produces idempotent station upserts, ordered `station_line_positions`, and a small `route_segment_connections` graph; the Worker never parses the CSV. Linear route segments are expanded with indexed `line_id + seq` ranges. Cross-segment routes are enumerated in TypeScript with at most three passenger transfers and eight segments, then ranked by Whisper-anchor coverage, anchor order, transfers, and detour. Exact-name anchors remain a fast shortcut, but are not immutable: when they are insufficient, inconsistent, or weak as a sequence, the app expands local paths around hard and soft candidate seeds in both `seq` directions and aligns the complete mention sequence with bounded station gaps. A multi-mention local route can therefore outrank one unrelated exact match, while minimum lexical coverage and route-score thresholds prevent route-only low-similarity stations from becoming answers by connectivity alone. Up to five route hypotheses, per-mention candidate rankings, and explicit anchor/fallback statuses are sent to Gemini #2 as evidence. A route-only station is context, not permission to add an unspoken stop to the normalized transcription.
- **Secrets:** `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, and `GEMINI_API_KEY` are Wrangler secrets and therefore absent from `vars`.

## Status transitions

`pending -> queued -> transcribing -> Gemini #1 safety/domain/structure -> sequence-scoped D1 routes -> Gemini #2 normalization -> completed`

Whisperの結果は、Geminiの厳格なSafety Settingsと公共交通案内のドメイン判定を通過するまで保存しない。Safety Block、公共交通以外、判定不能、Gemini障害はfail-closedとし、本文をD1へ保存せず後段処理を中断する。

Discord guildは既定で無効。`DISCORD_CONTROL_USER_IDS` に登録されたユーザーがサーバー内で `/platform-ai-agent-allow` を実行したguildだけが音声解析と検索を利用でき、`/platform-ai-agent-deny` で停止できる。

`/platform-ai-agent-demo` は同じ `DISCORD_CONTROL_USER_IDS` をBotオーナー設定として使用する。同期受付でIDを照合してからQueueへ完全な一時入力を渡し、Consumerは通常ジョブと同じ解析関数をインメモリのno-op永続化アダプタで実行する。したがってD1は駅候補の読み取りにだけ使われ、audio job、callback secret、文字起こしcheckpoint、clip、利用記録、ログの書き込みや後続cleanupは行わない。demo-only Queue batchではstale-job cleanupも起動しない。

Allowed terminal outcomes are `partial` and `failed`.

## Operational setup

Replace the placeholder D1 database ID, create the queue and DLQ, configure secrets, set `SCAN_CHANNELS` to a JSON array of `{ guildId, channelId }`, apply migrations, register Discord commands, then deploy. Command registration is a deployment-time REST operation, not Worker startup behavior.
