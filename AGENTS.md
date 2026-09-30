# Repository agent rules

## Audio processing anti-patterns

- Do not use `Promise.race` to abandon an in-flight Workers AI request on timeout; the provider operation can continue while retaining memory. Pass an `AbortSignal` to the Workers AI binding and abort that request at `min(14 minutes, max(10 minutes, audio duration × 3))` instead.
- Do not decode or transcode MP3 into PCM/WAV inside the Worker as a Whisper compatibility fallback. The WASM path is too slow and unreliable and can exhaust the Cloudflare Worker memory limit.
- On Workers AI MP3 decode failure, retry only with metadata-free MP3 frames. If that also fails, terminate with an explicit decode error instead of starting local WASM transcoding.
- Do not retry the complete audio pipeline after Whisper has already succeeded. Reuse the persisted transcription for downstream retries.
- Keep compressed source bytes as the durable in-process input; do not expand them to PCM for provider compatibility.
