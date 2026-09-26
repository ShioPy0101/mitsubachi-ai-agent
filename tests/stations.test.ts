import { describe, expect, it } from "vitest";
import { StationCandidateService, scoreStation, type StationRepository } from "../src/stations/candidate-service";
import { generateStationsSql, parseStationsCsv } from "../src/stations/import";
import { normalizeKana, normalizeStationName } from "../src/stations/normalization";
import { resolveStation } from "../src/stations/resolver";
import { levenshteinDistance, stationKanaSimilarity } from "../src/stations/similarity";
import type { Station, StationContext } from "../src/stations/types";
import { iseStations } from "./fixtures/stations";

class FixtureRepository implements StationRepository {
  constructor(private readonly stations: Station[]) {}
  async findCandidatePool(_searchText: string, _context: StationContext, _limit: number): Promise<Station[]> {
    return this.stations;
  }
}

describe("station normalization and ranking", () => {
  it("normalizes name, kana script and small-ke variants", () => {
    expect(normalizeStationName(" 五十鈴ヶ丘 ")).toBe(normalizeStationName("五十鈴ケ丘"));
    expect(normalizeKana("いすずゖおか")).toBe(normalizeKana("イスズガオカ"));
  });

  it("matches exact station names and normalized kana", () => {
    const station = iseStations[1];
    expect(station).toBeDefined();
    if (station === undefined) return;
    expect(scoreStation(station, "次は五十鈴ヶ丘です", {}).nameSimilarity).toBe(1);
    expect(stationKanaSimilarity("次はいすずがおかです", station.kana)).toBe(1);
  });

  it("calculates edit distance for fuzzy candidates", () => {
    expect(levenshteinDistance("いすずがおか", "いすずおか")).toBe(1);
    const station = iseStations[1];
    expect(station).toBeDefined();
    if (station === undefined) return;
    expect(scoreStation(station, "いすずおか", {}).kanaSimilarity).toBeGreaterThan(0.8);
  });

  it("adds line and previous/next adjacency bonuses", () => {
    const station = iseStations[1];
    expect(station).toBeDefined();
    if (station === undefined) return;
    const base = scoreStation(station, "いすずがおか", {});
    const previous = scoreStation(station, "いすずがおか", { lineName: "JR参宮線", previousStation: "伊勢市" });
    const next = scoreStation(station, "いすずがおか", { nextStation: "二見浦" });
    expect(previous.lineBonus).toBe(1);
    expect(previous.adjacencyBonus).toBe(1);
    expect(next.adjacencyBonus).toBe(1);
    expect(previous.score).toBeGreaterThan(base.score);
  });

  it("ranks 伊勢市 → 五十鈴ヶ丘 → 二見浦 context first", async () => {
    const candidates = await new StationCandidateService(new FixtureRepository(iseStations)).candidates(
      "次はいすずがおかです",
      { lineName: "JR参宮線", previousStation: "伊勢市", nextStation: "二見浦" },
    );
    expect(candidates[0]?.station.name).toBe("五十鈴ヶ丘");
    expect(candidates[0]?.score).toBeGreaterThan(candidates[1]?.score ?? 0);
  });

  it("returns unresolved for no candidates", () => {
    expect(resolveStation([], null)).toEqual({
      stationName: null, candidateStationId: null, confidence: 0, source: "unresolved",
    });
  });
});

describe("station CSV import", () => {
  it("parses the fixture and generates deterministic idempotent upserts", () => {
    const csv = "name,kana,kana_source,operator_name,line_name,prefecture,prev_station,next_station,longitude,latitude,postal\n五十鈴ヶ丘,いすずゖおか,pykakasi,,JR参宮線,三重県,伊勢市,二見浦,136.739797,34.495884,5160018\n";
    const rows = parseStationsCsv(csv);
    expect(rows).toHaveLength(1);
    const first = generateStationsSql(rows);
    expect(generateStationsSql(rows)).toBe(first);
    expect(first).toContain("ON CONFLICT DO UPDATE");
    expect(first).toContain("'いすずかおか'");
  });
});
