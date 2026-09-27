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
      searchText, searchText, prefix,
      context.lineName ?? null, context.lineName ?? null,
      context.prefecture ?? null, context.prefecture ?? null,
      context.previousStation ?? null, context.previousStation ?? null, context.previousStation ?? null,
      context.nextStation ?? null, context.nextStation ?? null, context.nextStation ?? null,
      searchText, searchText, context.lineName ?? null, searchText, limit,
    ).all();
    return result.results.map(toStation);
  }
}
