import type { Station } from "./types";
import type { SegmentConnection } from "./route-algorithms";
export type StaticStation = Station & {
  normalizedName: string;
  normalizedKana: string | null;
};
export type OrderedLinePath = {
  pathId: string;
  lineId: string;
  stationIds: number[];
  circular: boolean;
};
export type RailwayStaticData = {
  stations: StaticStation[];
  paths: OrderedLinePath[];
  connections: SegmentConnection[];
};
export function assertRailwayDataIntegrity(data: RailwayStaticData): void {
  const stations = new Set(data.stations.map((s) => s.id));
  if (stations.size !== data.stations.length)
    throw new Error("Duplicate station ID");
  const paths = new Map(data.paths.map((p) => [p.pathId, p]));
  if (paths.size !== data.paths.length) throw new Error("Duplicate path ID");
  for (const path of data.paths) {
    if (
      !path.stationIds.length ||
      new Set(path.stationIds).size !== path.stationIds.length
    )
      throw new Error(`Invalid path cycle/sequence: ${path.pathId}`);
    for (const id of path.stationIds)
      if (!stations.has(id)) throw new Error(`Missing path station: ${id}`);
  }
  const keys = new Set<string>();
  for (const connection of data.connections) {
    const from = paths.get(connection.from_segment_id),
      to = paths.get(connection.to_segment_id);
    if (
      !stations.has(connection.from_station_id) ||
      !stations.has(connection.to_station_id) ||
      from?.stationIds[connection.from_seq] !== connection.from_station_id ||
      to?.stationIds[connection.to_seq] !== connection.to_station_id ||
      ![0, 1].includes(connection.transfer_cost)
    )
      throw new Error("Invalid route connection");
    const key = `${connection.from_segment_id}:${connection.to_segment_id}:${connection.from_station_id}:${connection.to_station_id}`;
    if (keys.has(key)) throw new Error("Duplicate route connection");
    keys.add(key);
  }
}
