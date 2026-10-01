import { describe, expect, it, vi } from "vitest";
import migrationBaseline from "./fixtures/d1-migration-baseline.json";
import {
  lexicalSimilarities,
  STATION_SEQUENCE_LIMITS,
  StationCandidateService,
} from "../src/stations/candidate-service";
import {
  bestContainedSimilarity,
  stringSimilarity,
} from "../src/stations/similarity";
import { generateRailwayData } from "../src/stations/static-generator";
import { assertRailwayDataIntegrity } from "../src/stations/static-schema";
import { buildRailwayIndexes } from "../src/stations/static-indexes";
import { StaticRailwayRepository } from "../src/stations/static-repository";
import { railwayStaticData, railwayIndexes } from "../src/stations/static-data";
import type { StationImportRow } from "../src/stations/import";
const row = (
  name: string,
  lineName: string,
  prevStation: string | null,
  nextStation: string | null,
  kana = name,
): StationImportRow => ({
  name,
  lineName,
  prevStation,
  nextStation,
  kana,
  kanaSource: null,
  operatorName: null,
  prefecture: "テスト県",
  postal: "100",
  longitude: 1,
  latitude: 1,
});
const rows = [
  row("河和口", "河和線", null, "富貴", "こうわぐち"),
  row("富貴", "河和線", "河和口", "知多武豊", "ふき"),
  row("知多武豊", "河和線", "富貴", "上ゲ", "ちたたけとよ"),
  row("上ゲ", "河和線", "知多武豊", "青山", "あげ"),
  row("青山", "河和線", "上ゲ", "成岩", "あおやま"),
  row("成岩", "河和線", "青山", "知多半田", "ならわ"),
  row("知多半田", "河和線", "成岩", null, "ちたはんだ"),
  row("篠原", "琵琶湖線", null, "野洲", "しのはら"),
  row("野洲", "琵琶湖線", "篠原", "守山", "やす"),
  row("守山", "琵琶湖線", "野洲", null, "もりやま"),
  row("支線終点", "河和線", "富貴", null),
  row("富貴", "接続線", null, "別路線終点", "ふき"),
  row("別路線終点", "接続線", "富貴", null),
];
const data = generateRailwayData(rows);
describe("ordered static railway repository", () => {
  it("validates the complete generated snapshot and keeps branch memberships", () => {
    expect(() => assertRailwayDataIntegrity(railwayStaticData)).not.toThrow();
    const hub = data.stations.find(
      (s) => s.name === "富貴" && s.lineName === "河和線",
    )!;
    expect(
      buildRailwayIndexes(data).memberships.get(hub.id)!.length,
    ).toBeGreaterThan(1);
    expect(new Set(data.paths.map((p) => p.lineId)).size).toBeLessThan(
      data.paths.length,
    );
  });
  it("rejects invalid identities, missing stations and duplicate path positions", () => {
    expect(() =>
      assertRailwayDataIntegrity({
        ...data,
        stations: [...data.stations, data.stations[0]!],
      }),
    ).toThrow("Duplicate station ID");
    expect(() =>
      assertRailwayDataIntegrity({
        ...data,
        paths: [
          {
            pathId: "bad",
            lineId: "bad",
            stationIds: [99999],
            circular: false,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      assertRailwayDataIntegrity({
        ...data,
        paths: [
          { pathId: "bad", lineId: "bad", stationIds: [1, 1], circular: false },
        ],
      }),
    ).toThrow();
  });
  it("does not lose closing edges on a legal loop attached to a branch", () => {
    const loop = generateRailwayData([
      row("端", "循環", null, "公園"),
      row("公園", "循環", "端", "東"),
      row("東", "循環", "公園", "西"),
      row("西", "循環", "東", "公園"),
    ]);
    expect(() => assertRailwayDataIntegrity(loop)).not.toThrow();
    const ids = new Map(loop.stations.map((s) => [s.name, s.id]));
    const edges = new Set(
      loop.paths.flatMap((p) =>
        p.stationIds
          .slice(1)
          .map((id, i) =>
            [id, p.stationIds[i]!].sort((a, b) => a - b).join(":"),
          ),
      ),
    );
    expect(
      edges.has(
        [ids.get("西")!, ids.get("公園")!].sort((a, b) => a - b).join(":"),
      ),
    ).toBe(true);
  });
  for (const fixture of migrationBaseline)
    it(`preserves recorded D1 candidates/routes: ${fixture.caseId}`, async () => {
      const actual = await new StationCandidateService(
        new StaticRailwayRepository(buildRailwayIndexes(data)),
      ).analyzeMentions(fixture.names, {}, { phoneticHints: fixture.hints });
      // Snapshot scores reflect the old adjacency objective. Compare master
      // identities and spoken alignment, not historical confidence numbers.
      // B/D previously had no complete path: endpoint-preserving seeds now
      // recover the existing master paths, with the expected station IDs below.
      expect(
        actual.mentionCandidates.map((cs) =>
          cs.map((c) => c.station.id).sort((a, b) => a - b),
        ),
      ).toEqual(
        fixture.expectedCandidates.map((cs) =>
          cs.map((c) => c.station.id).sort((a, b) => a - b),
        ),
      );
      expect(
        actual.routeCandidates.map((r) => r.stations.map((s) => s.station.id)),
      ).toEqual(
        fixture.caseId === "B"
          ? [[1, 2, 3, 4, 5, 6, 7]]
          : fixture.caseId === "D"
            ? [[1, 2, 13]]
            : fixture.expectedRoutes.map((r) =>
                r.stations.map((s) => s.station.id),
              ),
      );
      expect(actual.metrics.d1QueryCount).toBe(0);
      expect(actual.metrics.d1RowsRead).toBe(0);
    });
  it("retains ordered same-line routes in both directions", async () => {
    const seeds = data.stations
      .filter((s) => s.lineName === "琵琶湖線")
      .map((s, mentionIndex) => ({
        stationId: s.id,
        mentionIndex,
        strength: 1,
      }));
    const routes = await new StaticRailwayRepository(
      buildRailwayIndexes(data),
    ).findLineRouteCandidates(seeds, 2);
    expect(routes).toHaveLength(2);
    expect(routes[0]!.stations.map((s) => s.station.id)).toEqual(
      [...routes[1]!.stations.map((s) => s.station.id)].reverse(),
    );
  });
  it("retains graph branches and a line transfer", async () => {
    const routes = await new StaticRailwayRepository(
      buildRailwayIndexes(data),
    ).findRouteCandidates(["河和口", "別路線終点"], 3, 2);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0]!.transferCount).toBe(1);
  });
  it("retains the full-source Meitetsu and phonetic-rescue regression", async () => {
    const service = new StationCandidateService(
      new StaticRailwayRepository(railwayIndexes),
    );
    const meitetsu = await service.analyzeMentions(
      ["神話口", "福岐", "千田竹豊", "上", "青山", "奈良", "千田半田"],
      {},
      {
        phoneticHints: [
          "こうわぐち",
          "ふき",
          "ちたたけとよ",
          "あげ",
          "あおやま",
          "なら",
          "ちたはんだ",
        ],
      },
    );
    expect(meitetsu.mentionCandidates.map((c) => c[0]?.station.name)).toEqual([
      "河和口",
      "富貴",
      "知多武豊",
      "上ゲ",
      "青山",
      "成岩",
      "知多半田",
    ]);
    expect(meitetsu.metrics.graphSearchCount).toBe(0);
    const shiga = await service.analyzeMentions(
      ["篠原", "安雪", "守山"],
      {},
      { phoneticHints: [null, "やす", null] },
    );
    expect(shiga.mentionCandidates.map((c) => c[0]?.station.name)).toEqual([
      "篠原",
      "野洲",
      "守山",
    ]);
  });
});

describe("安雪 / やすゆき phonetic candidate generation", () => {
  it("retains 野洲 in the bounded phonetic pool using contained reading evidence", async () => {
    expect(stringSimilarity("やすゆき", "やす")).toBe(0.5);
    expect(bestContainedSimilarity("やすゆき", "やす")).toBe(1);
    const repository = new StaticRailwayRepository(railwayIndexes);
    const result = await repository.findCandidatePools(
      ["安雪"],
      ["やすゆき"],
      {},
      STATION_SEQUENCE_LIMITS.surfaceCandidatesPerMention,
      STATION_SEQUENCE_LIMITS.phoneticCandidatesPerMention,
    );
    expect(result.phonetic[0]!.map((s) => s.name)).toContain("野洲");
    expect(result.phonetic[0]).toHaveLength(
      STATION_SEQUENCE_LIMITS.phoneticCandidatesPerMention,
    );
    // Suffix matches otherwise win the old station-ID tie-break and evict 野洲.
    expect(result.phonetic[0]!.every((s) => s.kana === "やす")).toBe(true);
    expect(repository.getQueryCount()).toBe(0);
  });

  it("scores the inferred reading highly without making phonetics hard lexical evidence", () => {
    const yasu = [...railwayIndexes.byId.values()].find(
      (s) => s.name === "野洲",
    )!;
    const similarities = lexicalSimilarities("安雪", yasu, "やすゆき");
    expect(similarities.phoneticSimilarity).toBe(1);
    expect(similarities.nameSimilarity).toBe(0);
    expect(similarities.kanaSimilarity).toBe(0);
    expect(similarities.lexicalSimilarity).toBe(0.5);
  });

  it("uses 京都 and 野洲 as fallback seeds and aligns the returned physical route", async () => {
    const repository = new StaticRailwayRepository(railwayIndexes);
    const graphSearch = vi.spyOn(repository, "findRouteCandidates");
    const result = await new StationCandidateService(
      repository,
    ).analyzeMentions(
      ["京都", "安雪"],
      {},
      { sequenceRole: "stops", phoneticHints: [null, "やすゆき"] },
    );
    expect(graphSearch).toHaveBeenCalledTimes(1);
    expect(graphSearch.mock.calls[0]![0]).toEqual(["京都", "野洲"]);
    const physicalRoutes = await (graphSearch.mock.results[0]!
      .value as ReturnType<StaticRailwayRepository["findRouteCandidates"]>);
    expect(physicalRoutes[0]!.stations.map((s) => s.station.name)).toEqual(
      expect.arrayContaining(["京都", "野洲"]),
    );
    expect(result.routeSearchStatus).toBe("matched");
    expect(
      result.routeCandidates[0]!.stations.map((s) => s.station.name),
    ).toEqual(["京都", "野洲"]);
    expect(result.routeCandidates[0]!.hardAnchorViolations).toBe(0);
    expect(
      result.mentionCandidates[1]!.find((c) => c.station.name === "野洲")!
        .bound,
    ).toBe(false);
  });
});
