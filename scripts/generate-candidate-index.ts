import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseStationsCsv } from "../src/stations/import";
import { generateRailwayData } from "../src/stations/static-generator";
import { generateCandidateIndexMigration } from "../src/stations/candidate-index-generator";
const csv = await readFile(process.argv[2] ?? "data/stations.csv", "utf8");
const snapshot = createHash("sha256").update(csv).digest("hex");
const data = generateRailwayData(parseStationsCsv(csv));
const target =
  process.argv[3] ?? "migrations/0011_indexed_station_candidates.sql";
const sql = generateCandidateIndexMigration(data.stations, snapshot);
await writeFile(target, sql);
console.log({
  target,
  stations: data.stations.length,
  bytes: Buffer.byteLength(sql),
  snapshot,
});
