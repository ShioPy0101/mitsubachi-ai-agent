import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { D1StationsRepository } from "../src/db/stations-repository";

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

    expect(routes).toHaveLength(3);
    expect(names(routes[0]!)).toEqual(["A", "B", "C", "Z"]);
    expect(routes[0]?.anchorCoverage).toBe(1);
    expect(routes[0]?.orderConsistency).toBe(1);
    expect(routes[0]!.score).toBeGreaterThan(routes[1]!.score);
    const wrongOrder = routes.find((route) => names(route).join() === "A,C,B,Z");
    expect(wrongOrder?.orderConsistency).toBeLessThan(1);
    expect(routes[0]!.score).toBeGreaterThan(wrongOrder!.score);
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
});
