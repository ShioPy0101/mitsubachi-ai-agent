# Filename and summary follow normalized metadata

Previously result assembly started from Gemini #1's draft metadata. Only
station/destination entities with matching mention IDs and selected roles could
update a few fields. The summary was never updated. A normalized document could
therefore say 敦賀 while the filename and summary still said 鶴ヶ.

Gemini #2 now returns final metadata alongside its reconstructed document in
the same request. The prompt identifies input metadata as a draft and asks for
the final summary and entity names to agree with the normalized document.
Result assembly uses this final metadata for the filename, clip persistence,
and both public/demo delivery. Explicit null values clear draft values. Raw
transcription and analysis metadata remain unchanged.

The final summary is a short factual note, for example
「11:10発 特急サンダーバード17号・和倉温泉行き。次は敦賀」.
Unknown fields are omitted. Stop lists can use 「停車駅：篠原・野洲・守山」;
other announcements describe the actual guidance without generic introductory
prose. These instructions guide Gemini output; local tests use fake responses
and do not measure live model writing quality.

Older responses/fixtures without final metadata remain supported. Linked
station entities can update corresponding draft station, destination and next
station fields, including stop mentions matching nextStation. A missing mention
ID can be resolved by an unambiguous source-text match; an invalid supplied ID
is not silently reassigned. Legacy summary replacement uses only linked,
unambiguous source-to-target mappings and one-pass replacement. No station is
guessed from the route or normalized prose alone.

Invalid auxiliary metadata does not reject valid normalized prose. When final
metadata is absent/invalid and entity links are unavailable, draft metadata can
still remain; that limitation is mitigated by requesting final metadata in the
provider response schema. No additional AI call, D1 query or migration is needed.
Previously saved clips are not automatically rewritten.

## Verification

- Filename regression: サンダーバード_17号_特急_和倉温泉行き_11時10分発_0番乗り場_次は敦賀.mp3.
- Final summary uses 敦賀 even when Gemini #2's entity list is empty.
- Legacy source mapping, unrelated entity rejection, explicit nulls, and valid
  prose with malformed auxiliary metadata are covered.
- Focused metadata/normalization tests: 15 passed. Typecheck passes.
- Local unit suite: 116/120 passed; four previously recorded failures remain.
- Worker pipeline: public/demo/downstream retry all pass (3/3), including local
  D1 next_station/summary/generated_filename and Discord content assertions.
- Tests use saved/fake model output; no paid API or production deployment.

```sh
pnpm test:station -t 'metadata|raw semantic normalized'
pnpm typecheck
pnpm exec vitest run tests/pipeline.integration.test.ts
```
