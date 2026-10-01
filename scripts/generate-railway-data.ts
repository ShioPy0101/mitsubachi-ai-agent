import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseStationsCsv } from "../src/stations/import";
import { generateRailwayData } from "../src/stations/static-generator";
if (process.argv[1]?.endsWith("generate-railway-data.ts")) {
  const input = process.argv[2] ?? "data/stations.csv",
    output = process.argv[3] ?? "data/generated";
  const csv = await readFile(input, "utf8"),
    data = generateRailwayData(parseStationsCsv(csv));
  await mkdir(output, { recursive: true });
  for (const [name, value] of [
    ["stations", data.stations],
    ["line-paths", data.paths],
    ["route-connections", data.connections],
  ] as const)
    await writeFile(`${output}/${name}.json`, JSON.stringify(value) + "\n");
  await writeFile(
    `${output}/manifest.json`,
    JSON.stringify(
      {
        schemaVersion: 1,
        source: input,
        sourceSha256: createHash("sha256").update(csv).digest("hex"),
        stationIds: "static snapshot-local IDs; never use as D1 foreign keys",
        stations: data.stations.length,
        paths: data.paths.length,
        connections: data.connections.length,
      },
      null,
      2,
    ) + "\n",
  );
  console.log({
    stations: data.stations.length,
    paths: data.paths.length,
    connections: data.connections.length,
  });
}
