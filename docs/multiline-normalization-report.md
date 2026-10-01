# Event assembly / multilingual / multi-line stop lists

## Final transcript and source boundaries

Gemini #2's nonempty, successfully parsed `normalizedTranscription` is the final
body. `normalizedEvents` and `missingSourceEventIds` remain diagnostics and never
assemble or restore the body. Whisper segments retain their full text, IDs and
source times. Gemini #1 spans annotate semantics; they do not split source text.
This behavior was introduced in a88bab4 and remains covered by the fragmented
span fixture J and public/demo/retry delivery integration tests.

No output guard, replacement allowlist or similarity rejection was added to
address assembly. Raw remains separate and immutable. Metadata/entity and
language observations never reject or modify provider prose.

## Language and corresponding announcements

Schemas and prompts support ja/en/zh/ko/unknown. Each language remains in its own
language, in source order, including equivalent translated announcements. The
normalization prompt explicitly requires all languages in the final body, not
only in debug events. Application code performs no multilingual deduplication,
translation or fusion. Language omissions are diagnostic only.

Mention language and equivalent announcement group survive analysis. If one
provider sequence ID spans languages, the engine splits it into separate spoken
sequences. Cross-language soft evidence requires a common nonempty announcement
group, different known languages, equal stop-list cardinality, a strong ordered
peer route, at least two lexical/phonetic correspondences, and no conflicting
exact anchor. It supplies candidates for existing mentions only, within the
five-candidate cap. Reconciliation still applies its lexical/route binding
requirements. Additional searches are included in timing/comparison/cache costs.

Static localized exact-name indexes reuse existing station identities. English
uses the existing romanization helper. Chinese simplified glyphs and Korean
aliases are limited local evidence; Korean aliases currently cover six station
names, not the entire railway master.

## Physical path versus spoken stops

`RoutePathCandidate.physicalRoute.segments` retain actual lineId, ordered pathId,
station IDs and path-local direction. `physicalStations` includes pass-through
stations; `spokenStopSequence` contains only matched existing mentions. Legacy
`stations` remains the spoken sequence after alignment. Mention route indexes
now refer to physical positions rather than compressed mention ordinals.

`lineTransitions` retains both endpoint identities. Shared IDs are deduplicated
at boundaries; same-name different IDs remain distinct, connected only through
an existing explicit static connection. Runtime never creates an edge from
station-name equality.

The same-line fast path remains first. If it cannot explain the sequence, the
existing indexed static connection graph constructs multi-line physical paths
and ordered alignment evaluates them. Graph loads are module-scoped and searches
use the job-local Promise cache. The existing `graph_fallback` diagnostic source
is retained for this connection-graph search; there is no unconditional second
search for an already solved same-line sequence.

Ordered subsequence alignment uses a prefix maximum in O(mentions × path).
The old four-/sixteen-station hard gap restriction is removed. A tiny proximity
tie preference is capped at 0.06 regardless of how many stations are passed;
it does not affect the final route score or reject a gap. Complete exact-anchor
order contradictions are rejected by the mechanical evidence engine, not by
a normalized-output validator.

Natural paths take priority over fewer-transfer but longer alternatives. A line
transition penalty is reduced from 0.08 to 0.015. Detour measures are relative to
the shortest complete anchored path, avoiding a penalty solely for a naturally
long express route. Revisited station identities detect backtracking; comparing
forward/reverse signs between unrelated lines would be misleading. Both ends
of a long spoken sequence are retained within the four-seed graph limit.

Search remains bounded: five candidates/mention, five hypotheses, four graph
seeds, three sequence workers, 256 physical stations/alignment, 100,000 comparison
budget, eight graph segments, three passenger transfer-cost units, 5,000 expanded
states. Budget-limited unresolved cases remain possible.

## Local verification

- `npm run typecheck`: passed.
- `npm test`: Node 96 tests and local Worker 136 tests passed; suites overlap.
- New regressions cover forward/reverse two-line paths, 30 unspoken stations on
  each line, twenty spoken stops across a boundary, explicit different-ID
  connection endpoints, contradictory order, all four language segments,
  missing-language observation, grouped multilingual candidate evidence and
  same sequence ID across languages.
- Existing regressions cover large detours, same-line fast path, station cache,
  single-occurrence rescue, top-five rescue, phonetic-only binding prevention,
  raw preservation and exact provider-body delivery through Discord mocks.
- Frozen D1 baseline candidate identities are retained. Historical adjacency
  confidence numbers are not required to remain identical. B/D now recover
  previously unresolved complete physical paths; expected IDs are explicit.
- Fixture J: malformed semantic character spans / fragmented debug events.
- Fixture K: four-language ordered stop lists with four Whisper-shaped segments.
  K is synthetic, explicitly not a verified real-audio model capture.

Commands:

```bash
pnpm test
pnpm test:station
pnpm eval:station fixtures/railway/J-event-assembly
pnpm eval:station fixtures/railway/K-four-languages
pnpm dev --port 8787
```

No paid API was called, no production deployment or migration was performed.
All station-phase D1 queries, rows read and writes remain zero. Operational D1
writes in normal public/demo execution remain intentional. There is no alpha.

## Measurement and limitations

`benchmarks/multiline-subsequence.json` records seven warm local Node fixture
runs. Earlier stored numbers are a historical reference, not a controlled
same-process comparison. Station median milliseconds: A 1.86 → 1.89,
B 13.02 → 11.46, C 21.70 → 24.66, D 2.36 → 6.34; new K 48.01.
C/D perform more complete bounded path work; this is not an across-the-board
speed improvement. A/B avoid graph search. No production CPU, whole audio-job
latency or accuracy claim follows from this microbenchmark.

| Risk | Status | Evidence / remaining limitation |
|---|---|---|
| Raw fragments restored into final body | resolved | J, normalization and Discord delivery tests; debug events never assemble prose |
| Gemini span used as a strict source split | resolved | Whisper segment provenance and malformed-span tests |
| Stop lists confined to one line | resolved | Physical segments/transitions and two-line/20-stop tests |
| Adjacent-only or fixed-gap matching | resolved | Prefix ordered subsequence and 30+30 pass-through tests |
| Line transitions treated as suspicious alone | mitigated | Small transition penalty, distance-first graph ranking |
| Huge detours / reversals | mitigated | Relative detour scoring, station-revisit penalty, existing detour regression; bounded search may miss an alternative |
| Runtime connections based solely on names | resolved | Existing indexed explicit edges and different-ID endpoint test; static generator's location-derived links still need data-quality review |
| Multilingual loss in application assembly | resolved | No dedup/reassembly; JA/EN/ZH/KO source and mock provider-body tests |
| Real Gemini output omits a language | observability only | Prompt requires preservation; missingLanguages observes omissions without rejecting or inserting raw slices; actual AI/audio validation remains necessary |
| Wrong equivalent announcement grouping | mitigated | Equal cardinality, ordered lexical correspondences, strong peer route and exact-anchor contradiction checks; semantic group IDs are model annotations |
| Chinese/Korean master alias completeness | still remaining | Limited glyph/alias maps; no claim of nationwide localized spelling coverage |
| Hard 256-station or graph budgets | still remaining | Explicit safety bounds; very long paths can remain unresolved |
| Real-audio precision / recall | still remaining | No new labeled real-audio evaluation or live Gemini/Whisper run |

Prompt-injection untrusted-data instructions and structured context are retained.
Relaxed model-output validation means erroneous or instruction-influenced model
prose cannot be ruled out; this report does not claim a deterministic security
guarantee for Gemini's final reconstruction.
