import { describe, it, expect } from "vitest";
import {
  StationCandidateService,
  reconcileStationMentionCandidates,
  type StationCandidateDiagnostics,
  type StationRepository,
} from "../src/stations/candidate-service";
import { mergeMentionCandidates } from "../src/stations/candidate-evidence";
import { iseStations } from "./fixtures/stations";
import {
  StaticRailwayRepository,
  createStaticRailwayJobCache,
} from "../src/stations/static-repository";
import { railwayIndexes } from "../src/stations/static-data";
import type { MentionStationCandidate } from "../src/stations/types";
const candidate: MentionStationCandidate = {
  station: iseStations[0]!,
  mentionIndex: 0,
  mentionText: "伊勢氏",
  bound: false,
  nameSimilarity: 0.7,
  kanaSimilarity: 0,
  phoneticSimilarity: 0,
  lexicalScore: 0.7,
  matchStrength: "soft",
  routeHypothesisIds: [0],
  bestRouteScore: 0.95,
  finalScore: 0.8,
};
function search(
  value: MentionStationCandidate,
  violations = 0,
): StationCandidateDiagnostics {
  return {
    mentionCandidates: [[value]],
    routeCandidates: [
      {
        score: 0.95,
        orderConsistency: 1,
        hardAnchorViolations: violations,
        stations: [{ station: value.station, routeIndex: 0 }],
        mentionMatches: [
          {
            mentionIndex: 0,
            mentionText: value.mentionText,
            station: value.station,
            routeIndex: 0,
            nameSimilarity: value.nameSimilarity,
            kanaSimilarity: value.kanaSimilarity,
            phoneticSimilarity: value.phoneticSimilarity,
            lexicalSimilarity: value.lexicalScore,
          },
        ],
        pathLength: 1,
        transferCount: 0,
        anchorCoverage: 1,
      },
    ],
    metrics: { reconciliationMs: 0, totalMs: 0 },
  } as StationCandidateDiagnostics;
}
describe("safe mechanical evidence independently of AI", () => {
  it("rescues a single occurrence only with strong lexical and consistent route evidence", () => {
    const evidence = search({ ...candidate });
    expect(reconcileStationMentionCandidates([evidence]).size).toBe(1);
    expect(evidence.mentionCandidates[0]![0]!.bound).toBe(true);
  });
  it("does not bind weak, phonetic-only, route-only or contradicting evidence", () => {
    for (const evidence of [
      search({ ...candidate, nameSimilarity: 0.1, phoneticSimilarity: 1 }),
      search({ ...candidate, bestRouteScore: 0.4 }),
      search({ ...candidate }, 1),
      search({ ...candidate, correctionEligible: false }),
    ])
      expect(reconcileStationMentionCandidates([evidence]).size).toBe(0);
  });
  it("merges by evidence strength irrespective of Map insertion order", () => {
    const bound = { ...candidate, bound: true, finalScore: 0.7 },
      highScore = { ...candidate, finalScore: 0.99 };
    expect(mergeMentionCandidates([[bound], [highScore]])).toEqual(
      mergeMentionCandidates([[highScore], [bound]]),
    );
    expect(mergeMentionCandidates([[bound], [highScore]])[0]!.bound).toBe(true);
  });
  it("shares concurrent identical path loads through a job-local Promise cache", async () => {
    const cache = createStaticRailwayJobCache();
    const repo1 = new StaticRailwayRepository(railwayIndexes, cache),
      repo2 = new StaticRailwayRepository(railwayIndexes, cache);
    const station = [...railwayIndexes.byId.values()].find(
      (s) => s.name === "篠原",
    )!;
    const input = [{ stationId: station.id, mentionIndex: 0, strength: 1 }];
    const [one, two] = await Promise.all([
      repo1.findLineRouteCandidates(input, 2),
      repo2.findLineRouteCandidates(input, 2),
    ]);
    expect(one).toBe(two);
    expect(cache.lineRoutes.size).toBe(1);
    expect(repo2.getCostMetrics().cacheHits).toBe(1);
  });
  it("rescues a dropped candidate only between unique strong neighboring anchors", async () => {
    const stations = ["始点", "名駅", "終点"].map((name, i) => ({
      ...iseStations[0]!,
      id: 10 + i,
      name,
      kana: null,
    }));
    const route = {
      stations: stations.map((station, routeIndex) => ({
        station,
        routeIndex,
      })),
      score: 1,
      anchorCoverage: 1,
      orderConsistency: 1,
      transferCount: 0,
      pathLength: 3,
    };
    const pool = Array.from({ length: 5 }, (_, i) => ({
      ...iseStations[0]!,
      id: 20 + i,
      name: `別候補${i}`,
      kana: null,
    }));
    const repository: StationRepository = {
      findCandidatePool: async () => [],
      findCandidatePools: async () => ({
        surface: [[stations[0]!], pool.slice(0, 3), [stations[2]!]],
        phonetic: [[], pool.slice(3), []],
      }),
      findLineRouteCandidates: async () => [route],
      findRouteCandidates: async () => [],
    };
    const diagnostics = await new StationCandidateService(
      repository,
    ).analyzeMentions(["始点", "名誤", "終点"]);
    const rescued = diagnostics.mentionCandidates[1]!.find(
      (c) => c.station.name === "名駅",
    );
    expect(rescued).toBeDefined();
    expect(rescued!.correctionEligible).toBe(true);
    const weak = await new StationCandidateService(repository).analyzeMentions([
      "始点",
      "全く別の語",
      "終点",
    ]);
    expect(
      weak.mentionCandidates[1]!.find((c) => c.station.name === "名駅")
        ?.correctionEligible ?? false,
    ).toBe(false);
  });
});

import { multilingualSupport } from "../src/stations/multilingual-evidence";
import { StationCorrectionEngine } from "../src/stations/correction-engine";
import { groupStationSequences } from "../src/stations/stop-sequences";
import type { StationMention } from "../src/metadata/service";

const translatedMentions = (): StationMention[] =>
  [
    ["篠原", "ja", 1, null],
    ["安雪", "ja", 1, "やす"],
    ["守山", "ja", 1, null],
    ["Shinohara", "en", 2, null],
    ["Yasu", "en", 2, null],
    ["Moriyama", "en", 2, null],
  ].map(([text, language, sequenceId, phoneticHint], i) => ({
    id: `m${i}`,
    text: text as string,
    language: language as "ja" | "en",
    sequenceId: sequenceId as number,
    phoneticHint: phoneticHint as string | null,
    equivalentEventGroupId: "same-broadcast",
    start: i * 20,
    end: i * 20 + 10,
    role: "stop",
  }));

it("uses grouped multilingual stops as soft evidence without inventing occurrences", async () => {
  const mentions = translatedMentions();
  const cache = createStaticRailwayJobCache();
  const result = await new StationCorrectionEngine(
    () => new StaticRailwayRepository(railwayIndexes, cache),
  ).run({
    transcription: mentions.map((m) => m.text).join("、"),
    mentions,
    context: { lineName: "琵琶湖線" },
  });
  expect(result.mentionEvidence).toHaveLength(6);
  const rescued = result.mentionEvidence.find(
    (e) => e.mention.text === "安雪",
  )!;
  expect(
    rescued.candidates.find((c) => c.station.name === "野洲")
      ?.crossLanguageEvidence?.[0]?.groupId,
  ).toBe("same-broadcast");
  const target = result.sequenceSearches.find((s) => s.id === 1)!;
  expect(
    multilingualSupport(
      {
        ...target,
        mentions: target.mentions.map((m) => ({
          ...m,
          equivalentEventGroupId: "another-broadcast",
        })),
      },
      result.sequenceSearches,
    ),
  ).toBeNull();
  expect(
    multilingualSupport(
      { ...target, mentions: target.mentions.slice(0, 2) },
      result.sequenceSearches,
    ),
  ).toBeNull();
  expect(
    multilingualSupport(
      { ...target, mentions: [...target.mentions].reverse() },
      result.sequenceSearches,
    ),
  ).toBeNull();
  expect(result.metrics.sequences.every((m) => m.d1QueryCount === 0)).toBe(
    true,
  );
});

it("separates translated announcements even if their provider sequence IDs coincide", () => {
  const mentions = translatedMentions().map((m) => ({ ...m, sequenceId: 1 }));
  const sequences = groupStationSequences(mentions);
  expect(sequences).toHaveLength(2);
  expect(sequences.map((s) => s.mentions.map((m) => m.language))).toEqual([
    ["ja", "ja", "ja"],
    ["en", "en", "en"],
  ]);
});
