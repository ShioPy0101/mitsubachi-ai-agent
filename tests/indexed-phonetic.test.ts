import { describe, it, expect } from "vitest";
import {
  IndexedStaticPhoneticSource,
  canReachPhoneticThreshold,
} from "../src/stations/phonetic-source";
import {
  bestContainedSimilarity,
  StationSimilarityCache,
  stringSimilarity,
} from "../src/stations/similarity";
import { railwayIndexes } from "../src/stations/static-data";
import {
  StaticRailwayRepository,
  createStaticRailwayJobCache,
} from "../src/stations/static-repository";
import { buildRailwayIndexes } from "../src/stations/static-indexes";

const strings = (length: number): string[] =>
  length === 0
    ? [""]
    : strings(length - 1).flatMap((s) => [s + "あ", s + "い", s + "う"]);
describe("lossless indexed phonetic shortlist", () => {
  it("retains every >= .6 result, including contained readings, against exhaustive edit distance", async () => {
    const template = [...railwayIndexes.byId.values()][0]!;
    const readings = [1, 2, 3, 4].flatMap(strings);
    const stations = readings.map((kana, i) => ({
      ...template,
      id: i + 1,
      normalizedKana: kana,
      kana,
    }));
    const source = new IndexedStaticPhoneticSource(
      buildRailwayIndexes({ stations, paths: [], connections: [] }),
    );
    for (const reading of [
      "あ",
      "い",
      "あいう",
      "うあいうあ",
      "いいいい",
      "あいあいあいう",
    ]) {
      const ids = new Set(await source.findIds(reading));
      for (const station of stations) {
        if (bestContainedSimilarity(reading, station.normalizedKana) < 0.6)
          continue;
        expect(ids.has(station.id), `${reading}/${station.kana}`).toBe(true);
        expect(
          canReachPhoneticThreshold(reading, station.normalizedKana),
          `${reading}/${station.kana}`,
        ).toBe(true);
      }
    }
  });
  it("matches the original full-master phonetic rank on representative real readings", async () => {
    const repo = new StaticRailwayRepository(railwayIndexes);
    for (const reading of [
      "やすゆき",
      "しんわぐち",
      "ふくき",
      "ちだたけとよ",
      "かみ",
      "なら",
      "ちだはんだ",
      "ふせ",
    ]) {
      const expected = [...railwayIndexes.byId.values()]
        .map((station) => ({
          station,
          score: station.normalizedKana
            ? bestContainedSimilarity(reading, station.normalizedKana)
            : 0,
          prefix:
            !!station.normalizedKana &&
            reading.startsWith(station.normalizedKana),
        }))
        .filter((v) => v.score >= 0.6)
        .sort(
          (a, b) =>
            b.score - a.score ||
            Number(b.prefix) - Number(a.prefix) ||
            Math.abs((a.station.normalizedKana?.length ?? 0) - reading.length) -
              Math.abs(
                (b.station.normalizedKana?.length ?? 0) - reading.length,
              ) ||
            a.station.id - b.station.id,
        )
        .slice(0, 2)
        .map((v) => v.station.id);
      expect(
        (
          await repo.findCandidatePools(["誤認識"], [reading], {}, 3, 2)
        ).phonetic[0]!.map((s) => s.id),
      ).toEqual(expected);
    }
  });
  it("shares simultaneous reading loads across sequences, preserving the Yasu rescue", async () => {
    const source = new IndexedStaticPhoneticSource(railwayIndexes);
    let calls = 0;
    const cache = createStaticRailwayJobCache();
    const wrapped = {
      findIds: (reading: string) => {
        calls++;
        return source.findIds(reading);
      },
      getCostMetrics: () => source.getCostMetrics(),
    };
    const a = new StaticRailwayRepository(railwayIndexes, cache, wrapped);
    const b = new StaticRailwayRepository(railwayIndexes, cache, wrapped);
    const results = await Promise.all([
      a.findCandidatePools(["安雪"], ["やすゆき"], {}, 3, 2),
      b.findCandidatePools(["安雪"], ["やすゆき"], {}, 3, 2),
    ]);
    expect(calls).toBe(1);
    expect(results[0]!.phonetic[0]!.some((s) => s.name === "野洲")).toBe(true);
    expect(results[1]).toEqual(results[0]);
    expect(cache.work.phoneticCacheHits).toBe(1);
    expect(cache.work.candidateSimilarityPairs).toBeLessThan(
      railwayIndexes.byId.size,
    );
  });
});

describe("job similarity work", () => {
  it("preserves exhaustive substring scores while skipping uncompetitive windows", () => {
    const inputs = [1, 2, 3, 4].flatMap(strings);
    for (const left of inputs)
      for (const right of inputs) {
        let expected = stringSimilarity(left, right);
        if (left.includes(right)) expected = 1;
        else
          for (
            let size = Math.max(1, right.length - 2);
            size <= Math.min(left.length, right.length + 2);
            size++
          )
            for (let start = 0; start + size <= left.length; start++)
              expected = Math.max(
                expected,
                stringSimilarity(left.slice(start, start + size), right),
              );
        expect(bestContainedSimilarity(left, right)).toBe(expected);
      }
  });
  it("caches normalized strings and DP including zero scores without conflating operations", () => {
    const cache = new StationSimilarityCache();
    expect(cache.normalize("ヤス", "kana")).toBe("やす");
    cache.normalize("ヤス", "kana");
    expect(cache.work.normalizationComputations).toBe(1);
    expect(cache.work.normalizationCacheHits).toBe(1);
    expect(cache.similarity("ああ", "いい")).toBe(0);
    const cells = cache.work.editDistanceCells;
    expect(cells).toBe(4);
    expect(cache.similarity("ああ", "いい")).toBe(0);
    expect(cache.work.editDistanceCells).toBe(cells);
    expect(cache.similarity("あいう", "あい", true)).toBe(1);
    expect(cache.similarity("あいう", "あい")).toBeCloseTo(2 / 3);
  });
  it("reuses ranking for different pool limits and preserves all equal-score station identities", async () => {
    const source = new IndexedStaticPhoneticSource(railwayIndexes);
    let calls = 0;
    const repo = new StaticRailwayRepository(
      railwayIndexes,
      createStaticRailwayJobCache(),
      {
        findIds: (reading) => {
          calls++;
          return source.findIds(reading);
        },
        getCostMetrics: () => source.getCostMetrics(),
      },
    );
    const first = await repo.findCandidatePools(
      ["安雪"],
      ["ヤスユキ"],
      {},
      3,
      2,
    );
    const before = repo.getCostMetrics().work!.editDistanceCells;
    const second = await repo.findCandidatePools(
      ["安雪"],
      ["やすゆき"],
      {},
      3,
      10,
    );
    expect(calls).toBe(1);
    expect(repo.getCostMetrics().work!.editDistanceCells).toBe(before);
    expect(second.phonetic[0]!.slice(0, 2)).toEqual(first.phonetic[0]);
    expect(second.phonetic[0]!.length).toBeGreaterThan(2);
  });
});
