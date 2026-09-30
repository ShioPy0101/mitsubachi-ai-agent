import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { D1StationsRepository } from "../src/db/stations-repository";
import { StationCandidateService } from "../src/stations/candidate-service";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const schema = [
  `CREATE TABLE IF NOT EXISTS stations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, kana TEXT, kana_source TEXT,
    operator_name TEXT, line_name TEXT, prefecture TEXT, prev_station TEXT,
    next_station TEXT, longitude REAL, latitude REAL, postal TEXT,
    normalized_name TEXT NOT NULL, normalized_kana TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS station_line_positions (
    line_id TEXT NOT NULL, station_id INTEGER NOT NULL, seq INTEGER NOT NULL,
    PRIMARY KEY (line_id, station_id), UNIQUE (line_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS route_segment_connections (
    from_segment_id TEXT NOT NULL, to_segment_id TEXT NOT NULL,
    from_station_id INTEGER NOT NULL, to_station_id INTEGER NOT NULL,
    from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL,
    transfer_cost INTEGER NOT NULL,
    PRIMARY KEY (from_segment_id, to_segment_id, from_station_id, to_station_id)
  )`,
];

async function station(id: number, name: string, line: string, prefecture = "テスト県"): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO stations (
      id, name, kana, kana_source, operator_name, line_name, prefecture,
      prev_station, next_station, longitude, latitude, postal, normalized_name, normalized_kana
    ) VALUES (?, ?, ?, NULL, 'テスト鉄道', ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
  `).bind(id, name, name, line, prefecture, id, id, `${id}`, name, name).run();
}

async function segment(lineId: string, stationIds: readonly number[]): Promise<void> {
  for (const [seq, stationId] of stationIds.entries()) {
    await env.DB.prepare(
      "INSERT INTO station_line_positions (line_id, station_id, seq) VALUES (?, ?, ?)",
    ).bind(lineId, stationId, seq).run();
  }
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
  await env.DB.prepare(`
    INSERT INTO route_segment_connections (
      from_segment_id, to_segment_id, from_station_id, to_station_id, from_seq, to_seq, transfer_cost
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(fromSegment, toSegment, fromStationId, toStationId, fromSeq, toSeq, transferCost).run();
}

async function connectBoth(
  leftSegment: string,
  rightSegment: string,
  leftStationId: number,
  rightStationId: number,
  leftSeq: number,
  rightSeq: number,
  transferCost: 0 | 1,
): Promise<void> {
  await connect(leftSegment, rightSegment, leftStationId, rightStationId, leftSeq, rightSeq, transferCost);
  await connect(rightSegment, leftSegment, rightStationId, leftStationId, rightSeq, leftSeq, transferCost);
}

const names = (route: { stations: Array<{ station: { name: string } }> }): string[] =>
  route.stations.map(({ station: value }) => value.name);

describe("D1 ordered station paths", () => {
  beforeEach(async () => {
    for (const statement of schema) await env.DB.exec(statement.replaceAll("\n", " "));
    await env.DB.exec("DELETE FROM route_segment_connections; DELETE FROM station_line_positions; DELETE FROM stations;");
  });

  it("uses an indexed seq range in both directions and excludes off-path stations", async () => {
    await Promise.all([
      station(1, "A", "本線"), station(2, "B", "本線"),
      station(3, "C", "本線"), station(4, "D", "本線"),
    ]);
    await segment("main", [1, 2, 3, 4]);
    const repository = new D1StationsRepository(env.DB);

    const forward = await repository.findRouteCandidates(["B", "D"], 5);
    const reverse = await repository.findRouteCandidates(["D", "B"], 5);

    expect(names(forward[0]!)).toEqual(["B", "C", "D"]);
    expect(names(reverse[0]!)).toEqual(["D", "C", "B"]);
    expect(names(forward[0]!)).not.toContain("A");
  });

  it("expands paths with one and multiple transfers", async () => {
    await Promise.all([
      station(1, "A", "L1"), station(2, "乗換1", "L1"),
      station(3, "乗換1", "L2"), station(4, "中間", "L2"), station(5, "乗換2", "L2"),
      station(6, "乗換2", "L3"), station(7, "終点", "L3"),
    ]);
    await segment("s1", [1, 2]);
    await segment("s2", [3, 4, 5]);
    await segment("s3", [6, 7]);
    await connectBoth("s1", "s2", 2, 3, 1, 0, 1);
    await connectBoth("s2", "s3", 5, 6, 2, 0, 1);
    const routes = await new D1StationsRepository(env.DB).findRouteCandidates(["A", "中間", "終点"], 5);

    expect(names(routes[0]!)).toEqual(["A", "乗換1", "中間", "乗換2", "終点"]);
    expect(routes[0]).toMatchObject({ anchorCoverage: 1, orderConsistency: 1, transferCount: 2 });
  });

  it("crosses branching route segments without treating the junction as a passenger transfer", async () => {
    await Promise.all([
      station(1, "A", "分岐線"), station(2, "B", "分岐線"),
      station(3, "C", "分岐線"), station(4, "D", "分岐線"),
    ]);
    await segment("branch-left", [1, 3]);
    await segment("branch-right", [2, 3]);
    await segment("branch-trunk", [3, 4]);
    await connectBoth("branch-left", "branch-trunk", 3, 3, 1, 0, 0);
    await connectBoth("branch-right", "branch-trunk", 3, 3, 1, 0, 0);
    const routes = await new D1StationsRepository(env.DB).findRouteCandidates(["B", "D"], 5);

    expect(names(routes[0]!)).toEqual(["B", "C", "D"]);
    expect(routes[0]?.transferCount).toBe(0);
  });

  it("ranks the route matching the complete Whisper anchor order first", async () => {
    await Promise.all([
      station(1, "A", "共通"), station(2, "X", "短絡線"), station(3, "Z", "共通"),
      station(4, "B", "案内線"), station(5, "C", "案内線"),
    ]);
    await segment("shortcut", [1, 2, 3]);
    await segment("announced", [1, 4, 5, 3]);
    await segment("wrong-order", [1, 5, 4, 3]);
    const routes = await new D1StationsRepository(env.DB).findRouteCandidates(["A", "B", "C", "Z"], 5);

    expect(routes.length).toBeGreaterThanOrEqual(3);
    expect(names(routes[0]!)).toEqual(["A", "B", "C", "Z"]);
    expect(routes[0]?.anchorCoverage).toBe(1);
    expect(routes[0]?.orderConsistency).toBe(1);
    expect(routes[0]!.score).toBeGreaterThan(routes[1]!.score);
    const wrongOrder = routes.find((route) => names(route).join() === "A,C,B,Z");
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

    const routes = await new D1StationsRepository(env.DB)
      .findRouteCandidates(["白鷺", "鯖江", "福井", "小浜"], 5, 2);

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

    const diagnostics = await new StationCandidateService(new D1StationsRepository(env.DB))
      .analyze("竹府、鯖江、福井");
    const takefu = diagnostics.candidates.find(({ station: value }) => value.name === "武生");

    expect(diagnostics.anchorNames).toEqual(["鯖江", "福井"]);
    expect(diagnostics.routeCandidates[0]?.stations.map(({ station: value }) => value.name))
      .toEqual(["武生", "鯖江", "北鯖江", "福井"]);
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

    const mentions = ["神話口", "福岐", "千田竹豊", "上", "青山", "奈良", "千田半田"];
    const diagnostics = await new StationCandidateService(new D1StationsRepository(env.DB))
      .analyzeMentions(mentions);

    expect(diagnostics.anchorNames).toEqual(["青山", "奈良", "半田"]);
    expect(diagnostics.anchorSearchStatus).toBe("inconsistent_anchors");
    expect(diagnostics.sequenceFallbackAttempted).toBe(true);
    expect(diagnostics.fallbackSearchStatus).toBe("matched");
    expect(diagnostics.routeSearchStatus).toBe("matched");
    expect(diagnostics.routeCandidates[0]?.source).toBe("sequence_fallback");
    expect(names(diagnostics.routeCandidates[0]!)).toEqual([
      "河和口", "富貴", "知多武豊", "上ゲ", "青山", "成岩", "知多半田",
    ]);
    expect(diagnostics.routeCandidates[0]!.score).toBeGreaterThan(0.5);
    expect(diagnostics.mentionCandidates[5]?.find(({ station: value }) => value.name === "奈良")?.matchStrength)
      .toBe("hard");
    expect(diagnostics.mentionCandidates[5]?.find(({ station: value }) => value.name === "成岩")?.matchStrength)
      .toBe("soft");
    expect(diagnostics.mentionCandidates.map((candidates) => candidates[0]?.station.name)).toEqual([
      "河和口", "富貴", "知多武豊", "上ゲ", "青山", "成岩", "知多半田",
    ]);
    expect(diagnostics.mentionCandidates[5]?.find(({ station: value }) => value.name === "成岩")?.finalScore)
      .toBeGreaterThan(
        diagnostics.mentionCandidates[5]?.find(({ station: value }) => value.name === "奈良")?.finalScore ?? 0,
      );
    expect(diagnostics.mentionCandidates[6]?.find(({ station: value }) => value.name === "知多半田")?.finalScore)
      .toBeGreaterThan(
        diagnostics.mentionCandidates[6]?.find(({ station: value }) => value.name === "半田")?.finalScore ?? 0,
      );
  });

  it("uses a direction sequence and destination context to rank 久保川 → 窪川", async () => {
    const routeNames = [
      "伊野", "枝川", "朝倉", "佐川", "斗賀野", "須崎",
      "土佐新荘", "安和", "土佐久礼", "影野", "六反地", "仁井田", "窪川",
    ];
    await Promise.all(routeNames.map((name, index) => station(index + 1, name, "JR土讃線", "高知県")));
    await segment("dosan-local", routeNames.map((_name, index) => index + 1));

    const diagnostics = await new StationCandidateService(new D1StationsRepository(env.DB)).analyzeMentions(
      ["伊野", "佐川", "須崎", "久保川"],
      {},
      { sequenceRole: "direction", destinationContext: true },
    );

    expect(diagnostics.sequenceFallbackAttempted).toBe(true);
    expect(diagnostics.routeSearchStatus).toBe("matched");
    expect(diagnostics.routeCandidates[0]?.mentionMatches?.map(({ station: value }) => value.name))
      .toEqual(["伊野", "佐川", "須崎", "窪川"]);
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
    await env.DB.prepare(
      "INSERT INTO station_line_positions (line_id, station_id, seq) VALUES ('hapi', 1, 10), ('hapi', 2, 11), ('hapi', 3, 15)",
    ).run();
    const repository = new D1StationsRepository(env.DB);

    const increasing = await repository.findRouteCandidates(["武生", "鯖江", "福井"], 5);
    const decreasing = await repository.findRouteCandidates(["福井", "鯖江", "武生"], 5);

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
    const repository = new D1StationsRepository(env.DB);

    const forward = await repository.findRouteCandidates(["福井", "芦原温泉", "加賀温泉", "金沢"], 5);
    const reverse = await repository.findRouteCandidates(["金沢", "加賀温泉", "芦原温泉", "福井"], 5);

    expect(names(forward[0]!)).toEqual(["福井", "芦原温泉", "加賀温泉", "金沢"]);
    expect(forward[0]).toMatchObject({ anchorCoverage: 1, orderConsistency: 1, transferCount: 1 });
    expect(names(reverse[0]!)).toEqual(["金沢", "加賀温泉", "芦原温泉", "福井"]);
    expect(reverse[0]).toMatchObject({ anchorCoverage: 1, orderConsistency: 1, transferCount: 1 });
  });

  it("does not connect same-name stations in different regions without a generated connection", async () => {
    await Promise.all([
      station(1, "始点", "北線", "北海道"), station(2, "中央", "北線", "北海道"),
      station(3, "中央", "南線", "沖縄県"), station(4, "終点", "南線", "沖縄県"),
    ]);
    await segment("north", [1, 2]);
    await segment("south", [3, 4]);

    await expect(new D1StationsRepository(env.DB).findRouteCandidates(["始点", "終点"], 5))
      .resolves.toEqual([]);
  });

  it("strongly penalizes a connected 40-station detour against a local route", async () => {
    await Promise.all([
      station(1, "始点", "共通線"),
      station(2, "終点", "共通線"),
      ...Array.from({ length: 40 }, (_, index) => station(index + 3, `迂回${index + 1}`, "迂回線")),
    ]);
    await segment("local", [1, 2]);
    await segment("detour", [1, ...Array.from({ length: 40 }, (_, index) => index + 3), 2]);

    const routes = await new D1StationsRepository(env.DB).findRouteCandidates(["始点", "終点"], 5);
    const local = routes.find((route) => route.pathLength === 2);
    const detour = routes.find((route) => route.pathLength === 42);

    expect(local?.score).toBeGreaterThan(detour?.score ?? 0);
    expect(detour?.score).toBeLessThanOrEqual(0.35);
  });
});
