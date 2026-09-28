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
  async findRouteCandidatePool(_anchorNames: readonly string[], _maxHops: number, _limit: number): Promise<Station[]> {
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

  it("uses a cross-line route candidate to recover a misrecognized stop", async () => {
    const awaraOnsen: Station = {
      id: 7995,
      name: "芦原温泉",
      kana: "あわらおんせん",
      kanaSource: "pykakasi",
      operatorName: null,
      lineName: "北陸新幹線",
      prefecture: "福井県",
      prevStation: "福井",
      nextStation: "加賀温泉",
      longitude: 136.235069,
      latitude: 36.214542,
      postal: "9190632",
    };
    const fukui: Station = {
      ...awaraOnsen,
      id: 7994,
      name: "福井",
      kana: "ふくい",
      lineName: "ハピラインふくい線",
      prevStation: "越前花堂",
      nextStation: "森田",
    };
    const kagaOnsen: Station = {
      ...awaraOnsen,
      id: 7407,
      name: "加賀温泉",
      kana: "かがおんせん",
      lineName: "IRいしかわ鉄道線",
      prevStation: "大聖寺",
      nextStation: "動橋",
    };
    const transcription = "和倉温泉行きです。停車駅は敦賀、福井、和倉温泉、加賀温泉です。";

    const scored = scoreStation(awaraOnsen, transcription, {});
    expect(scored.routeContextBonus).toBe(0);

    const candidates = await new StationCandidateService(new FixtureRepository([fukui, awaraOnsen, kagaOnsen]))
      .candidates(transcription);
    expect(candidates.find(({ station }) => station.name === "芦原温泉")).toMatchObject({
      routeContextBonus: 1,
    });
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
