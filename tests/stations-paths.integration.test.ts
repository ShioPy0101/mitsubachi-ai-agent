import { beforeEach, describe, expect, it } from "vitest";
import {
  createStaticRailwayJobCache,
  StaticRailwayRepository,
} from "../src/stations/static-repository";
import { buildRailwayIndexes } from "../src/stations/static-indexes";
import type { RailwayStaticData } from "../src/stations/static-schema";
import {
  reconcileStationMentionCandidates,
  StationCandidateService,
} from "../src/stations/candidate-service";

let data: RailwayStaticData;
async function station(
  id: number,
  name: string,
  line: string,
  prefecture = "テスト県",
  kana = name,
): Promise<void> {
  data.stations.push({
    id,
    name,
    lineName: line,
    prefecture,
    kana,
    kanaSource: null,
    operatorName: "テスト鉄道",
    prevStation: null,
    nextStation: null,
    longitude: id,
    latitude: id,
    postal: `${id}`,
    normalizedName: name,
    normalizedKana: kana,
  });
}
async function segment(
  lineId: string,
  stationIds: readonly number[],
): Promise<void> {
  data.paths.push({
    pathId: lineId,
    lineId,
    stationIds: [...stationIds],
    circular: false,
  });
}
async function connect(
  fromSegment: string,
  toSegment: string,
  fromStationId: number,
  toStationId: number,
  fromSeq: number,
  toSeq: number,
  transferCost: 0 | 1,
): Promise<void> {
  data.connections.push({
    from_segment_id: fromSegment,
    to_segment_id: toSegment,
    from_station_id: fromStationId,
    to_station_id: toStationId,
    from_seq: fromSeq,
    to_seq: toSeq,
    transfer_cost: transferCost,
  });
}
const repository = (cache = createStaticRailwayJobCache()) =>
  new StaticRailwayRepository(buildRailwayIndexes(data), cache);
async function connectBoth(
  leftSegment: string,
  rightSegment: string,
  leftStationId: number,
  rightStationId: number,
  leftSeq: number,
  rightSeq: number,
  transferCost: 0 | 1,
): Promise<void> {
  await connect(
    leftSegment,
    rightSegment,
    leftStationId,
    rightStationId,
    leftSeq,
    rightSeq,
    transferCost,
  );
  await connect(
    rightSegment,
    leftSegment,
    rightStationId,
    leftStationId,
    rightSeq,
    leftSeq,
    transferCost,
  );
}

const names = (route: {
  stations: Array<{ station: { name: string } }>;
}): string[] => route.stations.map(({ station: value }) => value.name);

describe("static ordered station paths", () => {
  beforeEach(() => {
    data = { stations: [], paths: [], connections: [] };
  });

  it("uses an indexed seq range in both directions and excludes off-path stations", async () => {
    await Promise.all([
      station(1, "A", "本線"),
      station(2, "B", "本線"),
      station(3, "C", "本線"),
      station(4, "D", "本線"),
    ]);
    await segment("main", [1, 2, 3, 4]);
    const repo = repository();

    const forward = await repo.findRouteCandidates(["B", "D"], 5);
    const reverse = await repo.findRouteCandidates(["D", "B"], 5);

    expect(names(forward[0]!)).toEqual(["B", "C", "D"]);
    expect(names(reverse[0]!)).toEqual(["D", "C", "B"]);
    expect(names(forward[0]!)).not.toContain("A");
  });

  it("expands paths with one and multiple transfers", async () => {
    await Promise.all([
      station(1, "A", "L1"),
      station(2, "乗換1", "L1"),
      station(3, "乗換1", "L2"),
      station(4, "中間", "L2"),
      station(5, "乗換2", "L2"),
      station(6, "乗換2", "L3"),
      station(7, "終点", "L3"),
    ]);
    await segment("s1", [1, 2]);
    await segment("s2", [3, 4, 5]);
    await segment("s3", [6, 7]);
    await connectBoth("s1", "s2", 2, 3, 1, 0, 1);
    await connectBoth("s2", "s3", 5, 6, 2, 0, 1);
    const routes = await repository().findRouteCandidates(
      ["A", "中間", "終点"],
      5,
    );

    expect(names(routes[0]!)).toEqual(["A", "乗換1", "中間", "乗換2", "終点"]);
    expect(routes[0]).toMatchObject({
      anchorCoverage: 1,
      orderConsistency: 1,
      transferCount: 2,
    });
  });

  it("crosses branching route segments without treating the junction as a passenger transfer", async () => {
    await Promise.all([
      station(1, "A", "分岐線"),
      station(2, "B", "分岐線"),
      station(3, "C", "分岐線"),
      station(4, "D", "分岐線"),
    ]);
    await segment("branch-left", [1, 3]);
    await segment("branch-right", [2, 3]);
    await segment("branch-trunk", [3, 4]);
    await connectBoth("branch-left", "branch-trunk", 3, 3, 1, 0, 0);
    await connectBoth("branch-right", "branch-trunk", 3, 3, 1, 0, 0);
    const routes = await repository().findRouteCandidates(["B", "D"], 5);

    expect(names(routes[0]!)).toEqual(["B", "C", "D"]);
    expect(routes[0]?.transferCount).toBe(0);
  });

  it("ranks the route matching the complete Whisper anchor order first", async () => {
    await Promise.all([
      station(1, "A", "共通"),
      station(2, "X", "短絡線"),
      station(3, "Z", "共通"),
      station(4, "B", "案内線"),
      station(5, "C", "案内線"),
    ]);
    await segment("shortcut", [1, 2, 3]);
    await segment("announced", [1, 4, 5, 3]);
    await segment("wrong-order", [1, 5, 4, 3]);
    const routes = await repository().findRouteCandidates(
      ["A", "B", "C", "Z"],
      5,
    );

    expect(routes.length).toBeGreaterThanOrEqual(3);
    expect(names(routes[0]!)).toEqual(["A", "B", "C", "Z"]);
    expect(routes[0]?.anchorCoverage).toBe(1);
    expect(routes[0]?.orderConsistency).toBe(1);
    expect(routes[0]!.score).toBeGreaterThan(routes[1]!.score);
    const wrongOrder = routes.find(
      (route) => names(route).join() === "A,C,B,Z",
    );
    expect(wrongOrder?.orderConsistency).toBeLessThan(1);
    expect(routes[0]!.score).toBeGreaterThan(wrongOrder!.score);
  });

  it("uses a strong adjacent anchor pair when false endpoint anchors have no route", async () => {
    await Promise.all([
      station(1, "白鷺", "別線", "大阪府"),
      station(2, "武生", "ハピラインふくい線", "福井県"),
      station(3, "鯖江", "ハピラインふくい線", "福井県"),
      station(4, "北鯖江", "ハピラインふくい線", "福井県"),
      station(5, "福井", "ハピラインふくい線", "福井県"),
      station(6, "小浜", "JR小浜線", "福井県"),
    ]);
    await segment("unrelated-train-name", [1]);
    await segment("hapi", [2, 3, 4, 5]);
    await segment("unrelated-line-name", [6]);

    const routes = await repository().findRouteCandidates(
      ["白鷺", "鯖江", "福井", "小浜"],
      5,
      2,
    );

    expect(routes.length).toBeGreaterThan(0);
    expect(names(routes[0]!)).toEqual(["武生", "鯖江", "北鯖江", "福井"]);
    expect(routes[0]).toMatchObject({ orderConsistency: 1, transferCount: 0 });
  });

  it("feeds 武生 back as route-supported context for 竹府 → 鯖江 → 福井", async () => {
    await Promise.all([
      station(1, "武生", "ハピラインふくい線", "福井県"),
      station(2, "鯖江", "ハピラインふくい線", "福井県"),
      station(3, "北鯖江", "ハピラインふくい線", "福井県"),
      station(4, "福井", "ハピラインふくい線", "福井県"),
    ]);
    await segment("hapi", [1, 2, 3, 4]);

    const diagnostics = await new StationCandidateService(repository()).analyze(
      "竹府、鯖江、福井",
    );
    const takefu = diagnostics.candidates.find(
      ({ station: value }) => value.name === "武生",
    );

    expect(diagnostics.anchorNames).toEqual(["鯖江", "福井"]);
    expect(
      diagnostics.routeCandidates[0]?.stations.map(
        ({ station: value }) => value.name,
      ),
    ).toEqual(["武生", "鯖江", "北鯖江", "福井"]);
    expect(takefu).toMatchObject({
      routeSupported: true,
      onExactPath: true,
      routeOrderConsistent: true,
      routeIndex: 0,
      routeCandidateIds: [0],
      bestRouteRank: 0,
      anchor: false,
    });
  });

  it("recovers the Meitetsu Kowa stop sequence from competing exact station names", async () => {
    await Promise.all([
      station(1, "河和口", "名鉄河和線", "愛知県"),
      station(2, "富貴", "名鉄河和線", "愛知県"),
      station(3, "知多武豊", "名鉄河和線", "愛知県"),
      station(4, "上ゲ", "名鉄河和線", "愛知県"),
      station(5, "青山", "名鉄河和線", "愛知県"),
      station(6, "成岩", "名鉄河和線", "愛知県"),
      station(7, "知多半田", "名鉄河和線", "愛知県"),
      station(20, "奈良", "JR大和路線", "奈良県"),
      station(21, "半田", "JR武豊線", "愛知県"),
    ]);
    await segment("meitetsu-kowa", [1, 2, 3, 4, 5, 6, 7]);
    await segment("unrelated-nara", [20]);
    await segment("unrelated-handa", [21]);

    const mentions = [
      "神話口",
      "福岐",
      "千田竹豊",
      "上",
      "青山",
      "奈良",
      "千田半田",
    ];
    const diagnostics = await new StationCandidateService(
      repository(),
    ).analyzeMentions(mentions);

    expect(diagnostics.anchorNames).toEqual(["青山", "奈良", "半田"]);
    expect(diagnostics.anchorSearchStatus).toBe("matched");
    expect(diagnostics.sequenceFallbackAttempted).toBe(false);
    expect(diagnostics.fallbackSearchStatus).toBe("not_attempted");
    expect(diagnostics.routeSearchStatus).toBe("matched");
    expect(diagnostics.routeCandidates[0]?.source).toBe("line_fast_path");
    expect(names(diagnostics.routeCandidates[0]!)).toEqual([
      "河和口",
      "富貴",
      "知多武豊",
      "上ゲ",
      "青山",
      "成岩",
      "知多半田",
    ]);
    expect(diagnostics.routeCandidates[0]!.score).toBeGreaterThan(0.5);
    expect(
      diagnostics.mentionCandidates[5]?.find(
        ({ station: value }) => value.name === "奈良",
      )?.matchStrength,
    ).toBe("hard");
    expect(
      diagnostics.mentionCandidates[5]?.find(
        ({ station: value }) => value.name === "成岩",
      )?.matchStrength,
    ).toBe("soft");
    expect(
      diagnostics.mentionCandidates.map(
        (candidates) => candidates[0]?.station.name,
      ),
    ).toEqual([
      "河和口",
      "富貴",
      "知多武豊",
      "上ゲ",
      "青山",
      "成岩",
      "知多半田",
    ]);
    expect(
      diagnostics.mentionCandidates[5]?.find(
        ({ station: value }) => value.name === "成岩",
      )?.finalScore,
    ).toBeGreaterThan(
      diagnostics.mentionCandidates[5]?.find(
        ({ station: value }) => value.name === "奈良",
      )?.finalScore ?? 0,
    );
    expect(
      diagnostics.mentionCandidates[6]?.find(
        ({ station: value }) => value.name === "知多半田",
      )?.finalScore,
    ).toBeGreaterThan(
      diagnostics.mentionCandidates[6]?.find(
        ({ station: value }) => value.name === "半田",
      )?.finalScore ?? 0,
    );
  });

  it("keeps a sufficiently resolved raw mention bound across later sequences", async () => {
    await Promise.all([
      station(1, "河和口", "名鉄河和線", "愛知県"),
      station(2, "富貴", "名鉄河和線", "愛知県"),
      station(3, "知多武豊", "名鉄河和線", "愛知県"),
      station(4, "上ゲ", "名鉄河和線", "愛知県"),
      station(5, "青山", "名鉄河和線", "愛知県"),
      station(6, "成岩", "名鉄河和線", "愛知県"),
      station(7, "知多半田", "名鉄河和線", "愛知県"),
      station(20, "松江", "一畑電車北松江線", "島根県"),
      station(21, "雲州平田", "一畑電車北松江線", "島根県"),
      station(22, "出雲市", "一畑電車北松江線", "島根県"),
    ]);
    await segment("meitetsu-kowa", [1, 2, 3, 4, 5, 6, 7]);
    await segment("ichibata", [20, 21, 22]);
    const service = new StationCandidateService(repository());
    const first = await service.analyzeMentions([
      "神話口",
      "福岐",
      "千田竹豊",
      "上",
      "青山",
      "奈良",
      "千田半田",
    ]);
    const later = await service.analyzeMentions(["松江", "千田半田", "出雲市"]);
    const bindings = reconcileStationMentionCandidates([first, later]);
    expect(bindings.get("千田半田")?.name).toBe("知多半田");
    expect(later.mentionCandidates[1]?.[0]).toMatchObject({
      station: { name: "知多半田" },
      bound: true,
      matchStrength: "hard",
    });
    expect(later.mentionCandidates[1]?.[0]?.station.name).not.toBe("雲州平田");
  });

  it("uses an inferred reading only as route-supported candidate rescue", async () => {
    await Promise.all([
      station(1, "篠原", "JR琵琶湖線", "滋賀県", "しのはら"),
      station(2, "野洲", "JR琵琶湖線", "滋賀県", "やす"),
      station(3, "守山", "JR琵琶湖線", "滋賀県", "もりやま"),
    ]);
    await segment("biwako", [1, 2, 3]);

    const diagnostics = await new StationCandidateService(
      repository(),
    ).analyzeMentions(
      ["篠原", "安雪", "守山"],
      {},
      { phoneticHints: [null, "やすゆき", null] },
    );

    expect(diagnostics.mentionCandidates[1]?.[0]).toMatchObject({
      station: { name: "野洲" },
      routeHypothesisIds: [0],
      bound: false,
    });
    expect(diagnostics.mentionCandidates[1]?.[0]?.phoneticSimilarity).toBe(1);
    expect(diagnostics.mentionCandidates[1]?.[0]?.nameSimilarity).toBeLessThan(
      0.5,
    );

    const unrelatedEnding = await new StationCandidateService(
      repository(),
    ).analyzeMentions(
      ["篠原", "安雪", "守山"],
      {},
      { phoneticHints: [null, "やすのり", null] },
    );
    expect(unrelatedEnding.mentionCandidates[1]?.[0]?.station.name).toBe(
      "野洲",
    );
    expect(
      unrelatedEnding.mentionCandidates[1]?.[0]?.routeHypothesisIds,
    ).toEqual([0]);
  });

  it("does not bind a phonetic-only station when the matched route contradicts it", async () => {
    await Promise.all([
      station(1, "始点", "案内線", "テスト県", "してん"),
      station(2, "中間", "案内線", "テスト県", "ちゅうかん"),
      station(3, "終点", "案内線", "テスト県", "しゅうてん"),
      station(20, "野洲", "別路線", "滋賀県", "やす"),
    ]);
    await segment("guide", [1, 2, 3]);
    await segment("unrelated-yasu", [20]);
    const diagnostics = await new StationCandidateService(
      repository(),
    ).analyzeMentions(
      ["始点", "安雪", "終点"],
      {},
      { phoneticHints: [null, "やすゆき", null] },
    );
    const yasu = diagnostics.mentionCandidates[1]?.find(
      ({ station: value }) => value.name === "野洲",
    );
    const bindings = reconcileStationMentionCandidates([diagnostics]);

    expect(yasu).toMatchObject({ routeHypothesisIds: [], bound: false });
    expect(yasu?.phoneticSimilarity).toBe(1);
    expect(yasu?.finalScore).toBeLessThan(0.2);
    expect(bindings.has("安雪")).toBe(false);
  });

  it("bounds candidates, hypotheses and zero D1 reads for a 20-mention sequence", async () => {
    const stationIds = Array.from({ length: 20 }, (_, index) => index + 1);
    const suffixes = [..."甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉"];
    await Promise.all(
      stationIds.map((id, index) =>
        station(
          id,
          `連続${suffixes[index]}`,
          "長大線",
          "テスト県",
          `れんぞく${index}`,
        ),
      ),
    );
    await segment("long-line", stationIds);

    const diagnostics = await new StationCandidateService(
      repository(),
    ).analyzeMentions(stationIds.map((_id, index) => `連続${suffixes[index]}`));

    expect(diagnostics.mentionCandidates).toHaveLength(20);
    expect(
      diagnostics.mentionCandidates.every(
        (candidates) => candidates.length <= 5,
      ),
    ).toBe(true);
    expect(diagnostics.routeCandidates.length).toBeLessThanOrEqual(5);
    expect(diagnostics.metrics).toMatchObject({
      mentions: 20,
      graphSearchCount: 0,
      fallbackExecuted: false,
      d1QueryCount: 0,
    });
    expect(diagnostics.metrics.uniqueCandidateCount).toBeLessThanOrEqual(
      20 * 5,
    );
    expect(diagnostics.metrics.routeHypothesesGenerated).toBeLessThanOrEqual(4);
  });

  it("reuses identical line metadata lookups through the job-local cache", async () => {
    await Promise.all([
      station(1, "始点", "本線"),
      station(2, "中間", "本線"),
      station(3, "終点", "本線"),
    ]);
    await segment("main", [1, 2, 3]);
    const cache = createStaticRailwayJobCache();

    const first = await new StationCandidateService(
      repository(cache),
    ).analyzeMentions(["始点", "中間", "終点"]);
    const second = await new StationCandidateService(
      repository(cache),
    ).analyzeMentions(["始点", "中間", "終点"]);

    expect(first.metrics.d1QueryCount).toBe(0);
    expect(second.metrics.d1QueryCount).toBe(0);
    expect(second.metrics.cacheHits).toBeGreaterThan(0);
    expect(names(second.routeCandidates[0]!)).toEqual(["始点", "中間", "終点"]);
  });

  it("caps graph fallback seeds and executes graph search only once", async () => {
    const stationIds = Array.from({ length: 10 }, (_, index) => index + 1);
    const suffixes = [..."甲乙丙丁戊己庚辛壬癸"];
    await Promise.all(
      stationIds.map((id, index) =>
        station(id, `孤立${suffixes[index]}`, `孤立線${id}`),
      ),
    );
    await Promise.all(stationIds.map((id) => segment(`isolated-${id}`, [id])));

    const diagnostics = await new StationCandidateService(
      repository(),
    ).analyzeMentions(stationIds.map((_id, index) => `孤立${suffixes[index]}`));

    expect(diagnostics.metrics.graphSearchCount).toBe(1);
    expect(diagnostics.metrics.fallbackSeedCount).toBeLessThanOrEqual(4);
    expect(diagnostics.metrics.routeHypothesesGenerated).toBeLessThanOrEqual(4);
    expect(diagnostics.routeCandidates.length).toBeLessThanOrEqual(5);
  });

  it("uses a direction sequence and destination context to rank 久保川 → 窪川", async () => {
    const routeNames = [
      "伊野",
      "枝川",
      "朝倉",
      "佐川",
      "斗賀野",
      "須崎",
      "土佐新荘",
      "安和",
      "土佐久礼",
      "影野",
      "六反地",
      "仁井田",
      "窪川",
    ];
    await Promise.all(
      routeNames.map((name, index) =>
        station(index + 1, name, "JR土讃線", "高知県"),
      ),
    );
    await segment(
      "dosan-local",
      routeNames.map((_name, index) => index + 1),
    );

    const diagnostics = await new StationCandidateService(
      repository(),
    ).analyzeMentions(
      ["伊野", "佐川", "須崎", "久保川"],
      {},
      { sequenceRole: "direction", destinationContext: true },
    );

    expect(diagnostics.sequenceFallbackAttempted).toBe(false);
    expect(diagnostics.metrics.graphSearchCount).toBe(0);
    expect(diagnostics.routeSearchStatus).toBe("matched");
    expect(
      diagnostics.routeCandidates[0]?.mentionMatches?.map(
        ({ station: value }) => value.name,
      ),
    ).toEqual(["伊野", "佐川", "須崎", "窪川"]);
    const destinationCandidates = diagnostics.mentionCandidates[3] ?? [];
    expect(destinationCandidates[0]?.station.name).toBe("窪川");
    expect(destinationCandidates[0]).toMatchObject({
      mentionText: "久保川",
      matchStrength: "soft",
      routeHypothesisIds: [0],
    });
    expect(destinationCandidates[0]!.lexicalScore).toBeGreaterThanOrEqual(0.5);
    expect(destinationCandidates[0]!.bestRouteScore).toBeGreaterThan(0.5);
  });

  it("accepts increasing and decreasing seq order without requiring adjacent seq values", async () => {
    await Promise.all([
      station(1, "武生", "ハピラインふくい線", "福井県"),
      station(2, "鯖江", "ハピラインふくい線", "福井県"),
      station(3, "福井", "ハピラインふくい線", "福井県"),
    ]);
    await segment("hapi", [1, 2, 3]);
    const repo = repository();

    const increasing = await repo.findRouteCandidates(
      ["武生", "鯖江", "福井"],
      5,
    );
    const decreasing = await repo.findRouteCandidates(
      ["福井", "鯖江", "武生"],
      5,
    );

    expect(names(increasing[0]!)).toEqual(["武生", "鯖江", "福井"]);
    expect(increasing[0]?.orderConsistency).toBe(1);
    expect(names(decreasing[0]!)).toEqual(["福井", "鯖江", "武生"]);
    expect(decreasing[0]?.orderConsistency).toBe(1);
  });

  it("prioritizes 福井 → 芦原温泉 → 加賀温泉 → 金沢 across connected segments in both directions", async () => {
    await Promise.all([
      station(1, "福井", "福井線", "福井県"),
      station(2, "芦原温泉", "福井線", "福井県"),
      station(3, "芦原温泉", "石川線", "福井県"),
      station(4, "加賀温泉", "石川線", "石川県"),
      station(5, "金沢", "石川線", "石川県"),
    ]);
    await segment("fukui", [1, 2]);
    await segment("ishikawa", [3, 4, 5]);
    await connectBoth("fukui", "ishikawa", 2, 3, 1, 0, 1);
    const repo = repository();

    const forward = await repo.findRouteCandidates(
      ["福井", "芦原温泉", "加賀温泉", "金沢"],
      5,
    );
    const reverse = await repo.findRouteCandidates(
      ["金沢", "加賀温泉", "芦原温泉", "福井"],
      5,
    );

    expect(names(forward[0]!)).toEqual([
      "福井",
      "芦原温泉",
      "加賀温泉",
      "金沢",
    ]);
    expect(forward[0]).toMatchObject({
      anchorCoverage: 1,
      orderConsistency: 1,
      transferCount: 1,
    });
    expect(names(reverse[0]!)).toEqual([
      "金沢",
      "加賀温泉",
      "芦原温泉",
      "福井",
    ]);
    expect(reverse[0]).toMatchObject({
      anchorCoverage: 1,
      orderConsistency: 1,
      transferCount: 1,
    });
  });

  it("does not connect same-name stations in different regions without a generated connection", async () => {
    await Promise.all([
      station(1, "始点", "北線", "北海道"),
      station(2, "中央", "北線", "北海道"),
      station(3, "中央", "南線", "沖縄県"),
      station(4, "終点", "南線", "沖縄県"),
    ]);
    await segment("north", [1, 2]);
    await segment("south", [3, 4]);

    await expect(
      repository().findRouteCandidates(["始点", "終点"], 5),
    ).resolves.toEqual([]);
  });

  it("strongly penalizes a connected 40-station detour against a local route", async () => {
    await Promise.all([
      station(1, "始点", "共通線"),
      station(2, "終点", "共通線"),
      ...Array.from({ length: 40 }, (_, index) =>
        station(index + 3, `迂回${index + 1}`, "迂回線"),
      ),
    ]);
    await segment("local", [1, 2]);
    await segment("detour", [
      1,
      ...Array.from({ length: 40 }, (_, index) => index + 3),
      2,
    ]);

    const routes = await repository().findRouteCandidates(["始点", "終点"], 5);
    const local = routes.find((route) => route.pathLength === 2);
    const detour = routes.find((route) => route.pathLength === 42);

    expect(local?.score).toBeGreaterThan(detour?.score ?? 0);
    expect(detour?.score).toBeLessThanOrEqual(0.35);
  });
});
