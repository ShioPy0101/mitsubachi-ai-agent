import { z } from "zod";
import type { StationRepository } from "../stations/candidate-service";
import type { Station, StationContext } from "../stations/types";

const StationRowSchema = z.object({
  id: z.number().int(), name: z.string(), kana: z.string().nullable(), kana_source: z.string().nullable(),
  operator_name: z.string().nullable(), line_name: z.string().nullable(), prefecture: z.string().nullable(),
  prev_station: z.string().nullable(), next_station: z.string().nullable(), longitude: z.number().nullable(),
  latitude: z.number().nullable(), postal: z.string().nullable(),
});

const toStation = (input: unknown): Station => {
  const row = StationRowSchema.parse(input);
  return {
    id: row.id, name: row.name, kana: row.kana, kanaSource: row.kana_source, operatorName: row.operator_name,
    lineName: row.line_name, prefecture: row.prefecture, prevStation: row.prev_station,
    nextStation: row.next_station, longitude: row.longitude, latitude: row.latitude, postal: row.postal,
  };
};

export class D1StationsRepository implements StationRepository {
  constructor(private readonly db: D1Database) {}

  async findCandidatePool(searchText: string, context: StationContext, limit: number): Promise<Station[]> {
    const prefix = searchText.slice(0, 2);
    const result = await this.db.prepare(`
      SELECT id, name, kana, kana_source, operator_name, line_name, prefecture,
             prev_station, next_station, longitude, latitude, postal
      FROM stations
      WHERE instr(?, normalized_name) > 0
         OR instr(?, normalized_kana) > 0
         OR normalized_kana LIKE ? || '%'
         OR (prev_station IS NOT NULL AND instr(?, prev_station) > 0)
         OR (next_station IS NOT NULL AND instr(?, next_station) > 0)
         OR (? IS NOT NULL AND line_name = ?)
         OR (? IS NOT NULL AND prefecture = ?)
         OR (? IS NOT NULL AND (prev_station = ? OR next_station = ?))
         OR (? IS NOT NULL AND (prev_station = ? OR next_station = ?))
      ORDER BY
        CASE WHEN instr(?, normalized_name) > 0 OR instr(?, normalized_kana) > 0 THEN 0 ELSE 1 END,
        CASE WHEN line_name = ? THEN 0 ELSE 1 END,
        abs(length(COALESCE(normalized_kana, normalized_name)) - length(?))
      LIMIT ?
    `).bind(
      searchText, searchText, prefix, searchText, searchText,
      context.lineName ?? null, context.lineName ?? null,
      context.prefecture ?? null, context.prefecture ?? null,
      context.previousStation ?? null, context.previousStation ?? null, context.previousStation ?? null,
      context.nextStation ?? null, context.nextStation ?? null, context.nextStation ?? null,
      searchText, searchText, context.lineName ?? null, searchText, limit,
    ).all();
    return result.results.map(toStation);
  }

  async findRouteCandidatePool(anchorNames: readonly string[], maxHops: number, limit: number): Promise<Station[]> {
    if (anchorNames.length < 2) return [];
    const placeholders = anchorNames.map(() => "?").join(", ");
    const result = await this.db.prepare(`
      WITH RECURSIVE route_walk(
        root_name, station_id, name, line_name, prev_station, next_station,
        latitude, longitude, postal, depth
      ) AS (
        SELECT name, id, name, line_name, prev_station, next_station,
               latitude, longitude, postal, 0
        FROM stations
        WHERE name IN (${placeholders})
        UNION
        SELECT route_walk.root_name, neighbor.id, neighbor.name, neighbor.line_name,
               neighbor.prev_station, neighbor.next_station,
               neighbor.latitude, neighbor.longitude, neighbor.postal, route_walk.depth + 1
        FROM route_walk
        INNER JOIN stations neighbor ON (
          (neighbor.line_name = route_walk.line_name
            AND (neighbor.name = route_walk.prev_station OR neighbor.name = route_walk.next_station))
          OR (neighbor.name = route_walk.name AND (
            (neighbor.latitude IS NOT NULL AND route_walk.latitude IS NOT NULL
              AND neighbor.longitude IS NOT NULL AND route_walk.longitude IS NOT NULL
              AND abs(neighbor.latitude - route_walk.latitude) <= 0.01
              AND abs(neighbor.longitude - route_walk.longitude) <= 0.01)
            OR (neighbor.postal IS NOT NULL AND neighbor.postal = route_walk.postal)
          ))
        )
        WHERE route_walk.depth < ?
      ), route_candidates AS (
        SELECT station_id, COUNT(DISTINCT root_name) AS anchor_count, MIN(depth) AS min_depth
        FROM route_walk
        GROUP BY station_id
        HAVING COUNT(DISTINCT root_name) >= 2
      )
      SELECT station.id, station.name, station.kana, station.kana_source, station.operator_name,
             station.line_name, station.prefecture, station.prev_station, station.next_station,
             station.longitude, station.latitude, station.postal
      FROM route_candidates
      INNER JOIN stations station ON station.id = route_candidates.station_id
      ORDER BY route_candidates.anchor_count DESC, route_candidates.min_depth ASC, station.name ASC
      LIMIT ?
    `).bind(...anchorNames, maxHops, limit).all();
    return result.results.map(toStation);
  }
}
