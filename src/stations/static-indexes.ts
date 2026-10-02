import type {
  RailwayStaticData,
  StaticStation,
  OrderedLinePath,
} from "./static-schema";
import { indexRouteGraph } from "./route-algorithms";
import type { LineMembership } from "./line-routes";
import { readingCounts } from "./phonetic-source";
import {
  stationNameInLanguage,
  normalizeLocalizedStationName,
} from "./language";
const add = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
};
export function buildRailwayIndexes(data: RailwayStaticData) {
  const byId = new Map<number, StaticStation>(),
    byName = new Map<string, StaticStation[]>(),
    byKana = new Map<string, StaticStation[]>();
  const byLocalizedName = new Map<string, StaticStation[]>();
  let kanaPostings:
    Map<string, { stationId: number; frequency: number }[]> | undefined;
  const nameGrams = new Map<string, StaticStation[]>(),
    kanaGrams = new Map<string, StaticStation[]>(),
    byAdjacent = new Map<string, StaticStation[]>();
  const pathsById = new Map<string, OrderedLinePath>(),
    pathsByLine = new Map<string, OrderedLinePath[]>(),
    memberships = new Map<number, LineMembership[]>();
  for (const station of data.stations) {
    byId.set(station.id, station);
    add(byName, station.normalizedName, station);
    for (const language of ["en", "zh", "ko"] as const) {
      const name = stationNameInLanguage(station, language);
      if (name)
        add(byLocalizedName, normalizeLocalizedStationName(name), station);
    }
    if (station.normalizedKana) add(byKana, station.normalizedKana, station);
    for (const [text, map] of [
      [station.normalizedName, nameGrams],
      [station.normalizedKana, kanaGrams],
    ] as const)
      if (text) {
        const grams = new Set<string>();
        for (let i = 0; i < text.length; i++) {
          grams.add(text.slice(i, i + 1));
          if (i + 1 < text.length) grams.add(text.slice(i, i + 2));
        }
        for (const gram of grams) add(map, gram, station);
      }
    for (const neighbor of new Set([station.prevStation, station.nextStation]))
      if (neighbor) add(byAdjacent, neighbor, station);
  }
  for (const path of data.paths) {
    pathsById.set(path.pathId, path);
    add(pathsByLine, path.lineId, path);
    path.stationIds.forEach((stationId, seq) =>
      add(memberships, stationId, {
        line_id: path.pathId,
        station_id: stationId,
        seq,
      }),
    );
  }
  return {
    byId,
    byName,
    byKana,
    // Production uses D1 postings. Build local postings only for an explicitly
    // selected in-memory source, avoiding unused cold-start allocations.
    get kanaPostings() {
      if (!kanaPostings) {
        kanaPostings = new Map();
        for (const station of byId.values())
          if (station.normalizedKana)
            for (const [token, frequency] of readingCounts(
              station.normalizedKana,
            ))
              add(kanaPostings, token, { stationId: station.id, frequency });
      }
      return kanaPostings;
    },
    byLocalizedName,
    nameGrams,
    kanaGrams,
    byAdjacent,
    pathsById,
    pathsByLine,
    memberships,
    graph: indexRouteGraph(data.connections),
  };
}
export type RailwayIndexes = ReturnType<typeof buildRailwayIndexes>;
