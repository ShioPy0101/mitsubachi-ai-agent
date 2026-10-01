# Architecture

Discord Interactions validate signatures, access, attachment and size; JobsRepository creates an idempotent operational job and Queue receives `{ jobId }`. Consumer validates/prepares the job, invokes the pipeline, and decides ack/retry/fatal handling.

```
Audio ingestion → Speech transcription → Semantic analysis
→ StationCorrectionEngine → Natural-language normalization
→ Normalization observations → Result assembly → Delivery
```

`src/pipeline/` contains stage adapters, common runner, orchestration, checkpoint, assembly and delivery. `src/stations/` contains the provider-independent correction domain and StaticRailwayRepository. It has no Cloudflare binding, Gemini, Discord or presentation-mode dependency. `src/metadata/` is the Gemini adapter, structured prompts/schemas and non-rejecting observations. `src/discord/` owns public/demo formatting.

Raw transcription is the immutable provider output. Operational transcription checkpoints use COALESCE; clip upserts never replace raw. Semantic events retain source spans, language, occurrence and segment provenance; normalized text is a freely reconstructed derived result. Gemini #2 is not a string replacement engine. Content similarity/allowed-target/rewrite/number guards do not reject generated prose. Invalid/empty JSON shape can fall back to raw with an observation. Both model prompts treat audio instructions as untrusted data. That mitigates prompt injection; it is not a deterministic content security boundary.

Source of truth is `data/stations.csv`. Build-time generation produces stations, ordered line paths and route connections with a version manifest. Branches are separate paths, legal loop closing edges are retained, and graph connections preserve segment positions/transfer costs. Indexes are constructed once per isolate. Both public and demo use this repository. D1 has no railway master queries or tables after migration 0010; retained resolution IDs are audit fields with snapshot provenance, not master foreign keys.

Same-line hypotheses come first; forward/reverse alignment, bounded graph fallback, job-local Promise cache, three sequence workers, seed/hypothesis/comparison caps and reconciliation remain. Mechanical hard bindings require lexical/surface or route support, never inferred phonetics alone. Evidence is still supplied to the language model even when hard binding is unsafe.

Queue wait, processing deadline, stage timeout, provider timeout budget and stale recovery are separate concepts. `started_at` remains the historical transcription start. `processing_started_at` starts on consumer processing; deadline = Whisper budget (10–14 minutes) + six minutes. Stale SELECT and atomic UPDATE both check deadline and active status. Whisper gets AbortSignal and is awaited after abort, not abandoned by Promise.race. Downstream retries reuse raw and version/hash-checked analysis/correction checkpoints.

D1 is durable mutable state; Discord monitor is a projection; Workers logs are operational diagnostics. Public formatting uses purpose-based language and generic errors. Demo includes model inputs/outputs, railway evidence, non-rejecting normalization observations, timing, D1 costs, funnel, missed mention and injection diagnostics. Demo is owner-only and persistent. No alpha mode exists.

Validation layers, commands, fixture limitations and real-AI capture are in [local-validation.md](docs/local-validation.md). Measured results and risk classifications are in [implementation-report.md](docs/implementation-report.md).
