import type { StaticStation } from "./static-schema";
import { readingCounts } from "./phonetic-source";

export function generateCandidateIndexMigration(
  stations: readonly StaticStation[],
  snapshot: string,
): string {
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const schema = `-- Generated from data/stations.csv. Do not edit data rows by hand.
-- These postings narrow candidate IDs only. Paths and graph remain static.
CREATE TABLE IF NOT EXISTS railway_candidate_snapshots (snapshot TEXT PRIMARY KEY, station_count INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS railway_candidate_tokens (
 snapshot TEXT NOT NULL, token TEXT NOT NULL, station_id INTEGER NOT NULL,
 frequency INTEGER NOT NULL, kana_length INTEGER NOT NULL,
 PRIMARY KEY (snapshot, token, kana_length, station_id)
) WITHOUT ROWID;
INSERT INTO railway_candidate_snapshots VALUES (${quote(snapshot)}, ${stations.length});\n`;
  const rows = stations.flatMap((s) =>
    s.normalizedKana
      ? [...readingCounts(s.normalizedKana)].map(
          ([token, count]) =>
            `(${quote(snapshot)},${quote(token)},${s.id},${count},${s.normalizedKana!.length})`,
        )
      : [],
  );
  const statements = [];
  for (let offset = 0; offset < rows.length; offset += 200)
    statements.push(
      `INSERT INTO railway_candidate_tokens VALUES\n${rows.slice(offset, offset + 200).join(",\n")};\n`,
    );
  return schema + statements.join("");
}
