import { describe, expect, it } from "vitest";
import {
  StationCandidateService,
  scoreStation,
  type StationRepository,
} from "../src/stations/candidate-service";
import {
  buildStationLinePositions,
  parseStationsCsv,
} from "../src/stations/import";
import {
  normalizeKana,
  normalizeStationName,
} from "../src/stations/normalization";
import { resolveStation } from "../src/stations/resolver";
import {
  groupStationSequences,
  groupStopSequences,
} from "../src/stations/stop-sequences";
import {
  levenshteinDistance,
  stationKanaSimilarity,
} from "../src/stations/similarity";
import type {
  RoutePathCandidate,
  Station,
  StationContext,
} from "../src/stations/types";
import { iseStations } from "./fixtures/stations";

class FixtureRepository implements StationRepository {
  constructor(
    private readonly stations: Station[],
    private readonly routes: RoutePathCandidate[] = [],
  ) {}
  async findCandidatePool(
    _searchText: string,
    _context: StationContext,
    _limit: number,
  ): Promise<Station[]> {
    return this.stations;
  }
  async findRouteCandidates(
    _anchorNames: readonly string[],
    maxCandidates: number,
  ): Promise<RoutePathCandidate[]> {
    return this.routes.slice(0, maxCandidates);
  }
}

describe("station normalization and ranking", () => {
  it("keeps destination and direction mentions out of ordered stop sequences", () => {
    const mentions = [
      {
        text: "名鉄名古屋",
        start: 0,
        end: 6,
        role: "direction" as const,
        sequenceId: null,
      },
      {
        text: "神宮前",
        start: 7,
        end: 10,
        role: "direction" as const,
        sequenceId: null,
      },
      {
        text: "名鉄一宮",
        start: 11,
        end: 15,
        role: "destination" as const,
        sequenceId: null,
      },
      { text: "A", start: 16, end: 17, role: "stop" as const, sequenceId: 1 },
      { text: "B", start: 18, end: 19, role: "stop" as const, sequenceId: 1 },
      { text: "C", start: 20, end: 21, role: "stop" as const, sequenceId: 1 },
    ];

    expect(groupStopSequences(mentions)).toEqual([
      {
        id: 1,
        role: "stops",
        mentions: mentions.slice(3),
        contextMentions: [],
      },
    ]);
  });

  it("groups a multi-station 方面案内 as direction and attaches a later destination as context", () => {
    const mentions = [
      {
        text: "伊野",
        start: 0,
        end: 2,
        role: "direction" as const,
        sequenceId: 1,
      },
      {
        text: "佐川",
        start: 3,
        end: 5,
        role: "direction" as const,
        sequenceId: 1,
      },
      {
        text: "須崎",
        start: 6,
        end: 8,
        role: "direction" as const,
        sequenceId: 1,
      },
      {
        text: "久保川",
        start: 18,
        end: 21,
        role: "destination" as const,
        sequenceId: null,
      },
    ];

    expect(groupStationSequences(mentions)).toMatchObject([
      {
        id: 1,
        role: "direction",
        mentions: mentions.slice(0, 3),
        contextMentions: [mentions[3]],
      },
      { role: "destination", mentions: [mentions[3]], contextMentions: [] },
    ]);
  });

  it("does not combine direction, destination and unrelated exact-looking mentions into one sequence", () => {
    const mentions = [
      {
        text: "名鉄名古屋",
        start: 0,
        end: 5,
        role: "direction" as const,
        sequenceId: 1,
      },
      {
        text: "名古屋",
        start: 6,
        end: 9,
        role: "direction" as const,
        sequenceId: 1,
      },
      {
        text: "名鉄一宮",
        start: 10,
        end: 14,
        role: "destination" as const,
        sequenceId: null,
      },
      {
        text: "一宮",
        start: 15,
        end: 17,
        role: "destination" as const,
        sequenceId: null,
      },
      {
        text: "青山",
        start: 18,
        end: 20,
        role: "unknown" as const,
        sequenceId: null,
      },
      {
        text: "奈良",
        start: 21,
        end: 23,
        role: "unknown" as const,
        sequenceId: null,
      },
      {
        text: "半田",
        start: 24,
        end: 26,
        role: "unknown" as const,
        sequenceId: null,
      },
    ];
    const sequences = groupStationSequences(mentions);

    expect(
      sequences.map(({ role, mentions: values }) => ({
        role,
        values: values.map(({ text }) => text),
      })),
    ).toEqual([
      { role: "direction", values: ["名鉄名古屋", "名古屋"] },
      { role: "destination", values: ["名鉄一宮"] },
      { role: "destination", values: ["一宮"] },
    ]);
    expect(
      sequences.every(
        ({ mentions: values }) => values.length < mentions.length,
      ),
    ).toBe(true);
  });

  it("keeps direction, destination and explicit stops as separate sequence roles", () => {
    const mentions = [
      {
        text: "伊野",
        start: 0,
        end: 2,
        role: "direction" as const,
        sequenceId: 1,
      },
      {
        text: "佐川",
        start: 3,
        end: 5,
        role: "direction" as const,
        sequenceId: 1,
      },
      {
        text: "窪川",
        start: 6,
        end: 8,
        role: "destination" as const,
        sequenceId: null,
      },
      { text: "朝倉", start: 9, end: 11, role: "stop" as const, sequenceId: 2 },
      {
        text: "伊野",
        start: 12,
        end: 14,
        role: "stop" as const,
        sequenceId: 2,
      },
    ];

    expect(groupStationSequences(mentions).map(({ role }) => role)).toEqual([
      "direction",
      "stops",
      "destination",
    ]);
  });

  it("normalizes name, kana script and small-ke variants", () => {
    expect(normalizeStationName(" 五十鈴ヶ丘 ")).toBe(
      normalizeStationName("五十鈴ケ丘"),
    );
    expect(normalizeKana("いすずゖおか")).toBe(normalizeKana("イスズガオカ"));
  });

  it("matches exact station names and normalized kana", () => {
    const station = iseStations[1];
    expect(station).toBeDefined();
    if (station === undefined) return;
    expect(scoreStation(station, "次は五十鈴ヶ丘です", {}).nameSimilarity).toBe(
      1,
    );
    expect(stationKanaSimilarity("次はいすずがおかです", station.kana)).toBe(1);
  });

  it("calculates edit distance for fuzzy candidates", () => {
    expect(levenshteinDistance("いすずがおか", "いすずおか")).toBe(1);
    const station = iseStations[1];
    expect(station).toBeDefined();
    if (station === undefined) return;
    expect(
      scoreStation(station, "いすずおか", {}).kanaSimilarity,
    ).toBeGreaterThan(0.8);
  });

  it("adds line and previous/next adjacency bonuses", () => {
    const station = iseStations[1];
    expect(station).toBeDefined();
    if (station === undefined) return;
    const base = scoreStation(station, "いすずがおか", {});
    const previous = scoreStation(station, "いすずがおか", {
      lineName: "JR参宮線",
      previousStation: "伊勢市",
    });
    const next = scoreStation(station, "いすずがおか", {
      nextStation: "二見浦",
    });
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
    const transcription =
      "和倉温泉行きです。停車駅は敦賀、福井、和倉温泉、加賀温泉です。";

    const scored = scoreStation(awaraOnsen, transcription, {});
    expect(scored.routeContextBonus).toBe(0);

    const route: RoutePathCandidate = {
      stations: [fukui, awaraOnsen, kagaOnsen].map((station, routeIndex) => ({
        station,
        routeIndex,
      })),
      anchorCoverage: 1,
      orderConsistency: 1,
      transferCount: 0,
      pathLength: 3,
      score: 0.9,
    };
    const candidates = await new StationCandidateService(
      new FixtureRepository([fukui, awaraOnsen, kagaOnsen], [route]),
    ).candidates(transcription);
    expect(
      candidates.find(({ station }) => station.name === "芦原温泉"),
    ).toMatchObject({
      routeContextBonus: 0.25,
      routeSupported: true,
      onExactPath: true,
      routeCandidateIds: [0],
      anchor: false,
    });
  });

  it("downweights an exact station-name match that conflicts with its stop-sequence route", async () => {
    const base = {
      kanaSource: "pykakasi",
      operatorName: null,
      lineName: "案内線",
      prefecture: "テスト県",
      prevStation: null,
      nextStation: null,
      longitude: null,
      latitude: null,
      postal: null,
    };
    const start: Station = { ...base, id: 1, name: "始点", kana: "してん" };
    const falseExact: Station = {
      ...base,
      id: 2,
      name: "奈良",
      kana: "なら",
      lineName: "別路線",
    };
    const end: Station = { ...base, id: 3, name: "終点", kana: "しゅうてん" };
    const route: RoutePathCandidate = {
      stations: [start, end].map((station, routeIndex) => ({
        station,
        routeIndex,
      })),
      anchorCoverage: 2 / 3,
      orderConsistency: 1,
      transferCount: 0,
      pathLength: 2,
      score: 0.7,
    };
    const transcription = "始点、奈良、終点の順に止まります";

    const candidates = await new StationCandidateService(
      new FixtureRepository([start, falseExact, end], [route]),
    ).candidates(transcription);
    const nara = candidates.find(({ station }) => station.name === "奈良");

    expect(scoreStation(falseExact, transcription, {}).nameSimilarity).toBe(1);
    expect(nara).toBeUndefined();
    expect(candidates[0]?.station.name).not.toBe("奈良");
  });

  it("re-evaluates 武生 from the ordered ? → 鯖江 → 福井 route context", async () => {
    const base = {
      kanaSource: "pykakasi",
      operatorName: null,
      lineName: "ハピラインふくい線",
      prefecture: "福井県",
      longitude: null,
      latitude: null,
      postal: null,
    };
    const takefu: Station = {
      ...base,
      id: 1,
      name: "武生",
      kana: "たけふ",
      prevStation: "王子保",
      nextStation: "鯖江",
    };
    const sabae: Station = {
      ...base,
      id: 2,
      name: "鯖江",
      kana: "さばえ",
      prevStation: "武生",
      nextStation: "北鯖江",
    };
    const fukui: Station = {
      ...base,
      id: 3,
      name: "福井",
      kana: "ふくい",
      prevStation: "越前花堂",
      nextStation: "森田",
    };
    const route: RoutePathCandidate = {
      stations: [takefu, sabae, fukui].map((station, routeIndex) => ({
        station,
        routeIndex,
      })),
      anchorCoverage: 1,
      orderConsistency: 1,
      transferCount: 0,
      pathLength: 3,
      score: 0.9,
    };

    const diagnostics = await new StationCandidateService(
      new FixtureRepository([sabae, fukui], [route]),
    ).analyze("竹府、鯖江、福井");

    expect(diagnostics.anchorNames).toEqual(["鯖江", "福井"]);
    expect(
      diagnostics.candidates.find(({ station }) => station.name === "武生"),
    ).toMatchObject({
      routeSupported: true,
      onExactPath: true,
      routeOrderConsistent: true,
      routeIndex: 0,
      previousAnchor: "鯖江",
      nextAnchor: "福井",
      routeCandidateIds: [0],
      bestRouteRank: 0,
      anchor: false,
      routeContextBonus: 0.25,
    });
  });

  it("keeps 鶴橋 as a hard anchor while route context resolves ambiguous preceding stops", async () => {
    const base = {
      kanaSource: "pykakasi",
      operatorName: "近畿日本鉄道",
      lineName: "近鉄大阪線",
      prefecture: "大阪府",
      prevStation: null,
      nextStation: null,
      longitude: null,
      latitude: null,
      postal: null,
    };
    const makeStation = (id: number, name: string, kana = name): Station => ({
      ...base,
      id,
      name,
      kana,
    });
    const correctStations = [
      makeStation(1, "桜井", "さくらい"),
      makeStation(2, "大和八木", "やまとやぎ"),
      makeStation(3, "大和高田", "やまとたかだ"),
      makeStation(4, "五位堂", "ごいどう"),
      makeStation(5, "河内国分", "かわちこくぶ"),
      makeStation(6, "布施", "ふせ"),
      makeStation(7, "鶴橋", "つるはし"),
    ];
    const wrongTail = [
      correctStations[0]!,
      correctStations[1]!,
      correctStations[2]!,
      makeStation(8, "五位堂", "ごいどう"),
      makeStation(9, "近鉄下田", "きんてつしもだ"),
      makeStation(10, "二上", "にじょう"),
      makeStation(11, "関屋", "せきや"),
    ];
    const route = (stations: Station[]): RoutePathCandidate => ({
      stations: stations.map((station, routeIndex) => ({
        station,
        routeIndex,
      })),
      anchorCoverage: 1,
      orderConsistency: 1,
      transferCount: 0,
      pathLength: stations.length,
      score: 0.9,
    });
    const diagnostics = await new StationCandidateService(
      new FixtureRepository(
        [...correctStations, ...wrongTail],
        [route(wrongTail), route(correctStations)],
      ),
    ).analyzeMentions([
      "桜井",
      "大和八木",
      "大和高田",
      "五井堂",
      "河内国部",
      "伏瀬",
      "鶴橋",
    ]);

    expect(diagnostics.anchorNames).toEqual([
      "桜井",
      "大和八木",
      "大和高田",
      "鶴橋",
    ]);
    expect(diagnostics.routeCandidates).toHaveLength(1);
    expect(
      diagnostics.routeCandidates[0]?.mentionMatches?.map(
        ({ station }) => station.name,
      ),
    ).toEqual([
      "桜井",
      "大和八木",
      "大和高田",
      "五位堂",
      "河内国分",
      "布施",
      "鶴橋",
    ]);
    expect(diagnostics.routeCandidates[0]).toMatchObject({
      exactAnchorCoverage: 1,
      hardAnchorViolations: 0,
    });
    const tsuruhashi = diagnostics.mentionCandidates[6]?.find(
      ({ station }) => station.name === "鶴橋",
    );
    expect(tsuruhashi).toMatchObject({
      lexicalScore: 1,
      matchStrength: "hard",
      routeHypothesisIds: [0],
    });
    expect(
      diagnostics.routeCandidates
        .flatMap(({ mentionMatches }) => mentionMatches ?? [])
        .some(
          ({ mentionText, station, lexicalSimilarity }) =>
            mentionText === "鶴橋" &&
            station.name === "関屋" &&
            lexicalSimilarity === 0,
        ),
    ).toBe(false);
  });

  it("still allows a zero-similarity route correction when the mention has no hard candidate", async () => {
    const base = {
      kanaSource: "pykakasi",
      operatorName: null,
      lineName: "本線",
      prefecture: null,
      prevStation: null,
      nextStation: null,
      longitude: null,
      latitude: null,
      postal: null,
    };
    const start: Station = { ...base, id: 1, name: "始点", kana: "してん" };
    const middle: Station = {
      ...base,
      id: 2,
      name: "中間",
      kana: "ちゅうかん",
    };
    const end: Station = { ...base, id: 3, name: "終点", kana: "しゅうてん" };
    const route: RoutePathCandidate = {
      stations: [start, middle, end].map((station, routeIndex) => ({
        station,
        routeIndex,
      })),
      anchorCoverage: 1,
      orderConsistency: 1,
      transferCount: 0,
      pathLength: 3,
      score: 0.9,
    };
    const diagnostics = await new StationCandidateService(
      new FixtureRepository([start, middle, end], [route]),
    ).analyzeMentions(["始点", "謎語", "終点"]);

    expect(diagnostics.routeCandidates[0]?.mentionMatches?.[1]).toMatchObject({
      mentionText: "謎語",
      station: { name: "中間" },
      lexicalSimilarity: 0,
    });
    expect(
      diagnostics.mentionCandidates[1]?.find(
        ({ station }) => station.name === "中間",
      ),
    ).toMatchObject({ routeHypothesisIds: [0] });
  });

  it("does not treat a one-character station as a substring of another station", async () => {
    const fuku: Station = {
      id: 2971,
      name: "福",
      kana: "ふく",
      kanaSource: "pykakasi",
      operatorName: null,
      lineName: "阪神なんば線",
      prefecture: "大阪府",
      prevStation: "出来島",
      nextStation: "伝法",
      longitude: 135.442692,
      latitude: 34.699791,
      postal: "5550034",
    };
    const service = new StationCandidateService(new FixtureRepository([fuku]));

    await expect(
      service.candidates("停車駅は敦賀、福井、芦原温泉です"),
    ).resolves.toEqual([]);
    await expect(service.candidates("次は福です")).resolves.toMatchObject([
      { station: { name: "福" } },
    ]);
  });

  it("ranks 伊勢市 → 五十鈴ヶ丘 → 二見浦 context first", async () => {
    const candidates = await new StationCandidateService(
      new FixtureRepository(iseStations),
    ).candidates("次はいすずがおかです", {
      lineName: "JR参宮線",
      previousStation: "伊勢市",
      nextStation: "二見浦",
    });
    expect(candidates[0]?.station.name).toBe("五十鈴ヶ丘");
    expect(candidates[0]?.score).toBeGreaterThan(candidates[1]?.score ?? 0);
  });

  it("returns unresolved for no candidates", () => {
    expect(resolveStation([], null)).toEqual({
      stationName: null,
      candidateStationId: null,
      confidence: 0,
      source: "unresolved",
    });
  });

  it("does not infer the recording station from a strong candidate", () => {
    const station = iseStations[1];
    expect(station).toBeDefined();
    if (station === undefined) return;
    const candidate = scoreStation(station, "次は五十鈴ヶ丘です", {});

    expect(resolveStation([candidate], null)).toMatchObject({
      stationName: null,
      candidateStationId: null,
      source: "unresolved",
    });
  });
});

describe("station CSV import", () => {
  it("parses the fixture and generates deterministic ordered static data", () => {
    const csv =
      "name,kana,kana_source,operator_name,line_name,prefecture,prev_station,next_station,longitude,latitude,postal\n五十鈴ヶ丘,いすずゖおか,pykakasi,,JR参宮線,三重県,伊勢市,二見浦,136.739797,34.495884,5160018\n";
    const rows = parseStationsCsv(csv);
    expect(rows).toHaveLength(1);
    const first = generateRailwayData(rows);
    expect(generateRailwayData(rows)).toEqual(first);
    expect(first.paths.length).toBeGreaterThan(0);
    expect(first.stations[0]!.normalizedKana).toBe("いすずかおか");
    expect(first.paths[0]!.stationIds).toEqual([1]);
    expect(first.connections).toEqual([]);
  });

  it("splits a branching line into ordered route segments", () => {
    const base = {
      kana: null,
      kanaSource: null,
      operatorName: "鉄道",
      lineName: "分岐線",
      prefecture: null,
      longitude: null,
      latitude: null,
      postal: null,
    };
    const rows = [
      { ...base, name: "A", prevStation: null, nextStation: "C" },
      { ...base, name: "B", prevStation: null, nextStation: "C" },
      { ...base, name: "C", prevStation: "A", nextStation: "D" },
      { ...base, name: "D", prevStation: "C", nextStation: null },
    ];
    const positions = buildStationLinePositions(rows);
    const segments = new Map<string, typeof positions>();
    for (const position of positions) {
      const segment = segments.get(position.lineId) ?? [];
      segment.push(position);
      segments.set(position.lineId, segment);
    }

    expect(segments.size).toBe(3);
    expect(
      [...segments.values()].map((segment) =>
        segment.map(({ station }) => station.name),
      ),
    ).toEqual(
      expect.arrayContaining([
        ["A", "C"],
        ["B", "C"],
        ["C", "D"],
      ]),
    );
  });
});

import { generateRailwayData } from "../src/stations/static-generator";
