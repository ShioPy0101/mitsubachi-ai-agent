# 伏瀬 / ふせ route alignment regression

The candidate pool already contained 布施. For 伏瀬 with inferred reading ふせ,
布施 had phonetic similarity 1 and lexical similarity 0.5. 長瀬 had surface
similarity 0.5, phonetic similarity about 0.333, and lexical similarity 0.5.
The existing surface-weighted alignment selected 長瀬 in both strategies, then
route support further promoted its candidate score.

Alignment now refines an interior match only when both neighbouring aligned
stations have direct surface/kana evidence >= 0.65, the current mention has no
hard anchor or binding, and its direct evidence is below 0.85. Exactly one
physical position between those neighbours must match the complete inferred
reading and have at least the current strict lexical strength. Multiple matching
positions remain unresolved. This is route evidence, not phonetic hard binding.
Scoring weights and route acceptance thresholds remain unchanged.

The resulting stop sequence is 桜井 → 大和八木 → 大和高田 → 五位堂 →
河内国分 → 布施 → 鶴橋 in strict, contained, and combined searches. The engine's
top candidate for 伏瀬 is 布施, with bound=false. Gemini #2 still reconstructs
the final wording; this deterministic test does not assert its live output.

The comparison-budget reservation includes the extra bounded scan. Correction
checkpoint version is updated so old 長瀬 evidence is not reused.

## Local reproduction

```sh
pnpm test:station -t 'anchored exact reading|compare deterministic|安雪 / やすゆき'
pnpm eval:station fixtures/railway/M-kintetsu-fuse-reading
pnpm typecheck
```

Fixture M contains the user-supplied raw text and 伏瀬 reading. Other readings
and analysis are manually annotated, not saved Gemini responses. Its local
engine evaluation returns 布施 and records station D1 reads=0, writes=0.

Sixteen focused tests pass, including the existing Meitetsu and 野洲 cases.
Negative cases cover exact 長瀬 surface, missing reading, reading outside the
neighbouring interval, weak neighbouring evidence, and multiple exact-reading
positions. Public/demo/retry Worker pipeline tests pass (3/3).

The full local unit suite passes 108/112 tests; the four previously recorded
failures remain outside this fix. Typecheck passes. A bad
inferred reading can still bias ambiguous material, and live Gemini/Discord
results require sample review. No external AI calls or deployment are required
for the regression fixture.
