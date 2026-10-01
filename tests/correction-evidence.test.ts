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
