# Repository agent rules

## Audio processing anti-patterns

- Do not use `Promise.race` to abandon an in-flight Workers AI request on timeout; the provider operation can continue and emit late progress while retaining memory. Whisper's timeout is only a terminal safety deadline, not a normal processing limit: use `min(14 minutes, max(10 minutes, audio duration × 3))`, show it in diagnostics, and enforce it cooperatively after the current provider call returns (and between bounded chunks).
- Do not decode or transcode an entire compressed audio file into an in-memory PCM/WAV buffer. Long MP3 input can expand to tens or hundreds of megabytes and exhaust the Cloudflare Worker memory limit.
- Do not retain all decoded PCM chunks before transcription. Decode a bounded chunk, submit it, release it, and then continue with the next chunk.
- Do not retry the complete audio pipeline after Whisper has already succeeded. Reuse the persisted transcription for downstream retries.
- For compressed-audio compatibility, prefer bounded streaming/chunked decoding with explicit progress reporting. Keep compressed source bytes as the durable in-process input and bound each decoded chunk independently.
