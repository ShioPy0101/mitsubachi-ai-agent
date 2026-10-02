import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import migration from "../migrations/0011_indexed_station_candidates.sql?raw";
import manifest from "../data/generated/manifest.json";
import { railwayIndexes } from "../src/stations/static-data";
import {
  IndexedStaticPhoneticSource,
  readingCounts,
} from "../src/stations/phonetic-source";
import { D1PhoneticCandidateSource } from "../src/db/phonetic-candidate-source";
import { createRailwayRepository } from "../src/db/railway-repository";
import { StationCorrectionEngine } from "../src/stations/correction-engine";
import { StaticRailwayRepository } from "../src/stations/static-repository";
import meitetsu from "../fixtures/railway/L-meitetsu-literal-readings/analysis.json";
import split from "../fixtures/railway/N-kintetsu-split-stop-sequences/analysis.json";
import transfer from "../fixtures/railway/D-transfer/analysis.json";
import type { StationMention } from "../src/metadata/service";

beforeAll(async () => {
  for (const statement of migration
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await env.DB.prepare(statement).run();
}, 30_000);
describe("D1 candidate index and static physical routes", () => {
  it("retrieves the same lossless shortlist as the local index", async () => {
    const d1 = new D1PhoneticCandidateSource(env.DB, manifest.sourceSha256);
    const local = new IndexedStaticPhoneticSource(railwayIndexes);
    for (const reading of [
      "やすゆき",
      "しんわぐち",
      "ふくき",
      "ちだたけとよ",
      "かみ",
      "なら",
      "ちだはんだ",
      "ふせ",
    ])
      expect((await d1.findIds(reading)).sort((a, b) => a - b)).toEqual(
        (await local.findIds(reading)).sort((a, b) => a - b),
      );
    expect(d1.getCostMetrics().queries).toBe(9);
    expect(d1.getCostMetrics().rowsRead).toEqual(expect.any(Number));
  });
  it("uses the posting primary key, not a full candidate-table scan", async () => {
    const result = await env.DB.prepare(
      `EXPLAIN QUERY PLAN WITH terms(token, frequency) AS (VALUES ('や',1),('す',1),('ゆ',1),('き',1))
      SELECT c.station_id FROM terms JOIN railway_candidate_tokens c ON c.snapshot = ? AND c.token = terms.token
      WHERE c.kana_length <= 6 GROUP BY c.station_id,c.kana_length HAVING SUM(MIN(c.frequency,terms.frequency)) >= (3*c.kana_length+4)/5`,
    )
      .bind(manifest.sourceSha256)
      .all<{ detail: string }>();
    const plan = result.results.map((row) => row.detail).join("\n");
    expect(plan).toMatch(/SEARCH c USING PRIMARY KEY/);
    expect(plan).toMatch(/kana_length<\?/);
    expect(plan).not.toMatch(/SCAN c\b/);
  });
  it("bounds rows read with indexed character and length predicates, independently of final pool limits", async () => {
    const source = new D1PhoneticCandidateSource(env.DB, manifest.sourceSha256);
    const ids = await source.findIds("ふせ");
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(railwayIndexes.byId.size / 10);
    expect(source.getCostMetrics().rowsRead).toBeLessThan(
      railwayIndexes.byId.size,
    );
    console.info("candidate_index_local_sample", {
      reading: "ふせ",
      ...source.getCostMetrics(),
    });
  });
  it("fails explicitly on snapshot mismatch instead of scanning or silently losing evidence", async () => {
    await expect(
      new D1PhoneticCandidateSource(env.DB, "wrong-version").findIds("やす"),
    ).rejects.toThrow("snapshot missing");
  });
  it.each([meitetsu, split, transfer])(
    "preserves correction, multiple sequences and route hypotheses",
    async (analysis) => {
      const input = {
        transcription: "fixture replay",
        mentions: analysis.mentions as StationMention[],
        context: {},
      };
      const repo = createRailwayRepository(env.DB);
      const hybrid = await new StationCorrectionEngine(() => repo).run(input);
      const localRepo = new StaticRailwayRepository(railwayIndexes);
      const local = await new StationCorrectionEngine(() => localRepo).run(
        input,
      );
      const outcome = (result: typeof local) => ({
        funnel: result.funnel,
        sequences: result.sequenceSearches.map((s) => ({
          status: s.stationSearch.routeSearchStatus,
          pools: s.stationSearch.mentionCandidates.map((cs) =>
            cs.map((c) => [c.station.id, c.finalScore, c.bound]),
          ),
          routes: s.stationSearch.routeCandidates.map((r) => [
            r.stations.map((s) => s.station.id),
            r.score,
            r.lineTransitions,
          ]),
        })),
      });
      expect(outcome(hybrid)).toEqual(outcome(local));
      const before = repo.getQueryCount();
      await repo.findRouteCandidates(["京都", "野洲"], 3);
      expect(repo.getQueryCount()).toBe(before);
      if (input.mentions.some((m) => m.phoneticHint))
        expect(
          hybrid.metrics.work?.candidateGeneration?.queries,
        ).toBeGreaterThan(0);
      else expect(hybrid.metrics.work?.candidateGeneration?.queries).toBe(0);
      expect(
        hybrid.metrics.work?.candidateScoring.computations,
      ).toBeGreaterThan(0);
      expect(hybrid.metrics.work?.repository?.graphStatesExpanded).toEqual(
        expect.any(Number),
      );
      expect(
        hybrid.metrics.work?.candidateScoring.similarityWork.editDistanceCells,
      ).toBeGreaterThan(0);
      expect(
        hybrid.metrics.work?.sequenceReconciliation.occurrenceLists,
      ).toBeGreaterThan(0);
    },
  );
  it("can read long hints without exceeding binding limits", async () => {
    const reading = [
      ...readingCounts(
        "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん",
      ),
    ]
      .map(([c]) => c)
      .join("");
    const d1 = new D1PhoneticCandidateSource(env.DB, manifest.sourceSha256);
    const local = new IndexedStaticPhoneticSource(railwayIndexes);
    expect((await d1.findIds(reading)).sort((a, b) => a - b)).toEqual(
      (await local.findIds(reading)).sort((a, b) => a - b),
    );
  });
});
