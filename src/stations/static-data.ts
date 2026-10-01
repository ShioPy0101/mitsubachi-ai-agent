import stations from "../../data/generated/stations.json";
import paths from "../../data/generated/line-paths.json";
import connections from "../../data/generated/route-connections.json";
import { buildRailwayIndexes } from "./static-indexes";
import type { RailwayStaticData } from "./static-schema";
export const railwayStaticData: RailwayStaticData = {
  stations,
  paths,
  connections,
};
// Construct once per isolate; repositories and jobs share immutable master indexes.
export const railwayIndexes = buildRailwayIndexes(railwayStaticData);
