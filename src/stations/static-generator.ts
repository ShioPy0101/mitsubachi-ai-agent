import { buildStationLinePositions, type StationImportRow } from "./import";
import { normalizeKana, normalizeStationName } from "./normalization";
import {
  assertRailwayDataIntegrity,
  type RailwayStaticData,
  type OrderedLinePath,
} from "./static-schema";
import type { SegmentConnection } from "./route-algorithms";
export function generateRailwayData(
  rows: readonly StationImportRow[],
): RailwayStaticData {
  const identity = (s: StationImportRow) =>
    JSON.stringify([s.name, s.lineName, s.operatorName]);
  const unique = [...new Map(rows.map((row) => [identity(row), row])).values()];
  const stations = unique.map((row, index) => ({
    ...row,
    id: index + 1,
    normalizedName: normalizeStationName(row.name),
    normalizedKana: row.kana === null ? null : normalizeKana(row.kana),
  }));
  const byIdentity = new Map(stations.map((s) => [identity(s), s]));
  const pathsById = new Map<string, OrderedLinePath>();
  for (const position of buildStationLinePositions(unique)) {
    const path = pathsById.get(position.lineId) ?? {
      pathId: position.lineId,
      lineId: JSON.stringify([
        position.station.operatorName ?? "",
        position.station.lineName,
      ]),
      stationIds: [],
      circular: false,
    };
    path.stationIds[position.seq] = byIdentity.get(
      identity(position.station),
    )!.id;
    pathsById.set(position.lineId, path);
  }
  const paths = [...pathsById.values()];
  const byId = new Map(stations.map((s) => [s.id, s]));
  for (const path of paths) {
    const first = byId.get(path.stationIds[0]!)!,
      last = byId.get(path.stationIds.at(-1)!)!;
    path.circular =
      path.stationIds.length > 2 &&
      [last.prevStation, last.nextStation].includes(first.name);
  }
  const memberships = new Map<number, Array<{ pathId: string; seq: number }>>();
  for (const path of paths)
    path.stationIds.forEach((id, seq) => {
      const list = memberships.get(id) ?? [];
      list.push({ pathId: path.pathId, seq });
      memberships.set(id, list);
    });
  const byName = new Map<string, typeof stations>();
  for (const station of stations) {
    const list = byName.get(station.name) ?? [];
    list.push(station);
    byName.set(station.name, list);
  }
  const connections: SegmentConnection[] = [];
  for (const from of stations)
    for (const to of byName.get(from.name) ?? []) {
      const same = from.id === to.id;
      const colocated =
        (from.postal !== null && from.postal === to.postal) ||
        (from.latitude !== null &&
          to.latitude !== null &&
          from.longitude !== null &&
          to.longitude !== null &&
          Math.abs(from.latitude - to.latitude) <= 0.01 &&
          Math.abs(from.longitude - to.longitude) <= 0.01);
      if (!same && !colocated) continue;
      for (const a of memberships.get(from.id) ?? [])
        for (const b of memberships.get(to.id) ?? []) {
          if (a.pathId === b.pathId) continue;
          connections.push({
            from_segment_id: a.pathId,
            to_segment_id: b.pathId,
            from_station_id: from.id,
            to_station_id: to.id,
            from_seq: a.seq,
            to_seq: b.seq,
            transfer_cost: same ? 0 : 1,
          });
        }
    }
  connections.sort(
    (a, b) =>
      a.from_segment_id.localeCompare(b.from_segment_id) ||
      a.from_seq - b.from_seq ||
      a.to_segment_id.localeCompare(b.to_segment_id) ||
      a.to_seq - b.to_seq,
  );
  const data = { stations, paths, connections };
  assertRailwayDataIntegrity(data);
  return data;
}
