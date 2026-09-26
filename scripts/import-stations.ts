import { readFile, writeFile } from "node:fs/promises";
import { generateStationsSql, parseStationsCsv } from "../src/stations/import";

const inputPath = process.argv[2] ?? "data/stations.csv";
const outputPath = process.argv[3] ?? "stations-import.sql";
const csv = await readFile(inputPath, "utf8");
const rows = parseStationsCsv(csv);
await writeFile(outputPath, generateStationsSql(rows), "utf8");
console.log(`Generated ${outputPath} with ${rows.length} idempotent station upserts.`);
