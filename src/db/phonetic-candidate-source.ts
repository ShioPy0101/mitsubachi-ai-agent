import {
  readingCounts,
  type PhoneticCandidateSource,
} from "../stations/phonetic-source";

/** D1 supplies IDs only. Names, paths, graph and final scores remain static. */
export class D1PhoneticCandidateSource implements PhoneticCandidateSource {
  private queries = 0;
  private rowsRead: number | undefined = 0;
  private returnedIds = 0;
  private ready: Promise<void> | undefined;
  constructor(
    private readonly db: D1Database,
    private readonly snapshot: string,
  ) {}
  getCostMetrics() {
    return {
      queries: this.queries,
      ...(this.rowsRead === undefined ? {} : { rowsRead: this.rowsRead }),
      postingRows: 0,
      returnedIds: this.returnedIds,
    };
  }
  private record(result: D1Result) {
    this.queries++;
    if (typeof result.meta.rows_read !== "number") this.rowsRead = undefined;
    else if (this.rowsRead !== undefined)
      this.rowsRead += result.meta.rows_read;
  }
  private ensureSnapshot(): Promise<void> {
    return (this.ready ??= (async () => {
      const result = await this.db
        .prepare(
          "SELECT snapshot FROM railway_candidate_snapshots WHERE snapshot = ?",
        )
        .bind(this.snapshot)
        .all();
      this.record(result);
      if (!result.results.length)
        throw new Error(
          "Railway candidate index snapshot missing; apply generated candidate-index migration before deployment",
        );
    })());
  }
  async findIds(reading: string): Promise<number[]> {
    if (!reading) return [];
    await this.ensureSnapshot();
    const terms = [...readingCounts(reading)];
    // Chunking keeps bindings under D1's limit. Union overlap across chunks is
    // calculated locally without changing recall, even for unusually long hints.
    const overlap = new Map<number, { count: number; length: number }>();
    for (let offset = 0; offset < terms.length; offset += 40) {
      const chunk = terms.slice(offset, offset + 40);
      const result = await this.db
        .prepare(
          `WITH terms(token, frequency) AS (VALUES ${chunk.map(() => "(?, ?)").join(",")})
        SELECT c.station_id, c.kana_length, SUM(MIN(c.frequency, terms.frequency)) AS overlap
        FROM terms JOIN railway_candidate_tokens c ON c.snapshot = ? AND c.token = terms.token
        WHERE c.kana_length <= ? GROUP BY c.station_id, c.kana_length
        ${terms.length <= 40 ? "HAVING SUM(MIN(c.frequency, terms.frequency)) >= (3 * c.kana_length + 4) / 5" : ""}`,
        )
        .bind(...chunk.flat(), this.snapshot, Math.floor(reading.length / 0.6))
        .all<{ station_id: number; kana_length: number; overlap: number }>();
      this.record(result);
      for (const row of result.results) {
        const old = overlap.get(row.station_id);
        overlap.set(row.station_id, {
          count: (old?.count ?? 0) + row.overlap,
          length: row.kana_length,
        });
      }
    }
    const ids = [...overlap]
      .filter(([, v]) => v.count >= Math.ceil(0.6 * v.length))
      .map(([id]) => id);
    this.returnedIds += ids.length;
    return ids;
  }
}
