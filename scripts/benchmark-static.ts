import { performance } from "node:perf_hooks";
import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
// Measure parsing/indexing separately from tsx/module transpilation overhead.
const { buildRailwayIndexes } = await import("../src/stations/static-indexes");
const initialMemory = process.memoryUsage(),
  initialCpu = process.cpuUsage(),
  start = performance.now();
const read = async (name: string) =>
  JSON.parse(await readFile(`data/generated/${name}.json`, "utf8"));
const railwayStaticData = {
  stations: await read("stations"),
  paths: await read("line-paths"),
  connections: await read("route-connections"),
};
const parseMs = performance.now() - start,
  indexStart = performance.now();
const railwayIndexes = buildRailwayIndexes(railwayStaticData);
const indexBuildMs = performance.now() - indexStart,
  importMs = performance.now() - start,
  cpu = process.cpuUsage(initialCpu),
  memory = process.memoryUsage();
const { evaluateFixture } = await import("./eval-station");
const cases = [];
for (const name of [
  "A-exact",
  "B-meitetsu",
  "C-long",
  "D-transfer",
  "E-ambiguous",
  "F-multilingual",
  "G-injection",
  "H-single",
  "I-repeated",
]) {
  const timings: number[] = [];
  let last;
  for (let i = 0; i < 7; i++) {
    last = await evaluateFixture(`fixtures/railway/${name}`);
    timings.push(last.stationMs);
  }
  cases.push({
    case: name,
    medianStationMs: timings.sort((a, b) => a - b)[3],
    stationD1Queries: 0,
    stationD1RowsRead: 0,
    stationD1Writes: 0,
    metrics: last!.correction.metrics,
    totalJobMs: null,
    precision: null,
    recall: null,
    falseCorrectionRate: null,
  });
}
const files = [];
for (const name of ["stations", "line-paths", "route-connections"]) {
  const file = await readFile(`data/generated/${name}.json`);
  files.push({ name, bytes: file.length, gzipBytes: gzipSync(file).length });
}
const report = {
  environment:
    "Node.js local microbenchmark; CPU/memory and import wall time are NOT production Worker measurements",
  nodeVersion: process.version,
  stations: railwayStaticData.stations.length,
  paths: railwayStaticData.paths.length,
  connections: railwayStaticData.connections.length,
  indexSizes: {
    stations: railwayIndexes.byId.size,
    paths: railwayIndexes.pathsById.size,
  },
  importMs,
  parseMs,
  indexBuildMs,
  cpuMs: (cpu.user + cpu.system) / 1000,
  heapDeltaBytes: memory.heapUsed - initialMemory.heapUsed,
  rssDeltaBytes: memory.rss - initialMemory.rss,
  files,
  cases,
  unmeasured: [
    "production Worker CPU",
    "production cold start",
    "full audio job wall clock",
    "real-audio correction precision/recall",
  ],
};
await writeFile(
  "docs/benchmarks/static-worker-memory.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
