# Deterministic station strategy comparison

The station service evaluates both strict whole-name evidence and contained-name
route evidence. It selects one complete result using shared strict lexical
measurements, matched anchor count, and route detour/direction evidence. A tie
retains the strict result. Hard binding continues to use strict lexical evidence;
the alternative route score does not automatically authorize a correction.

Candidate pools and identical graph requests share Promise caches. The two
alignments share the existing 100,000-comparison budget. The alternative path
pre-ranking uses exact-name anchors, ordered forward/reverse matching, a
20,000-comparison budget, and the existing route-length cap. No additional AI
calls or station-related D1 calls are introduced. Deterministic CPU work increases.

Demo diagnostics show both attempts, their statuses and routes, and the selected
strategy. The correction checkpoint key is updated to avoid reusing old results.

## Reproduction

```sh
pnpm test:station -t 'compare deterministic|安雪 / やすゆき'
pnpm eval:station fixtures/railway/L-meitetsu-literal-readings
pnpm typecheck
```

Fixture L preserves the supplied demo mention readings. Its raw transcription
is synthetic and 青山's reading is assumed to be あおやま. It is a regression
fixture, not a real-audio precision benchmark.

The seven-stop sequence selects the contained strategy and returns 河和口 →
富貴 → 知多武豊 → 上ゲ → 青山 → 成岩 → 知多半田. Kyoto plus 安雪 with
やすゆき retains 野洲 and selects the strict strategy. Exact ties retain strict;
contradictory order and phonetic-only hard binding remain rejected.

## Verification

- Seven focused strategy/phonetic tests pass; typecheck passes.
- Local unit suite: 99/103 pass. Four failures reproduce on the earlier branch
  baseline: candidate snapshot, old same-line fallback expectation, and two
  no-hint Meitetsu/binding cases. They remain unresolved.
- Worker suite: 134/136 pass. The two prompt/Whisper literal expectation failures
  also reproduce on the earlier baseline. Pipeline tests pass.
- No external AI calls, production deployment, or production migrations were
  performed for this change.

This mitigates the supplied Meitetsu regression without changing global
route/alignment thresholds. It does not guarantee all noisy station sequences
are solvable. Accuracy and live Discord output still require observed samples.
