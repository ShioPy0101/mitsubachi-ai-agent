import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { StationCorrectionEngine } from "../src/stations/correction-engine";
import {
  StaticRailwayRepository,
  createStaticRailwayJobCache,
} from "../src/stations/static-repository";
import { railwayIndexes } from "../src/stations/static-data";
import { buildSemanticRepresentation } from "../src/railway/semantic";
import { buildGeminiNormalizationPrompt } from "../src/metadata/prompt";
import type { AnnouncementAnalysis } from "../src/metadata/service";
export async function loadFixture(folder: string) {
  const transcription = JSON.parse(
    await readFile(join(folder, "transcription.json"), "utf8"),
  );
  const analysis: AnnouncementAnalysis = JSON.parse(
    await readFile(join(folder, "analysis.json"), "utf8"),
  );
  if (analysis.semantic?.rawTranscription !== transcription.text)
    analysis.semantic = buildSemanticRepresentation(
      transcription.text,
      analysis.mentions,
    );
  return { transcription, analysis };
}
export async function evaluateFixture(folder: string) {
  const { transcription, analysis } = await loadFixture(folder);
  const started = performance.now();
  const railwayCache = createStaticRailwayJobCache();
  const correction = await new StationCorrectionEngine(
    () => new StaticRailwayRepository(railwayIndexes, railwayCache),
  ).run({
    transcription: transcription.text,
    mentions: analysis.mentions,
    context: {},
  });
  const stationMs = performance.now() - started;
  const material = correction.sequenceSearches.map((s) => ({
    ...s,
    stationCandidates: s.stationSearch.candidates,
    mentionCandidates: s.stationSearch.mentionCandidates,
    routeHypotheses: s.stationSearch.routeCandidates,
  }));
  return {
    raw: transcription.text,
    semantic: analysis.semantic,
    correction,
    stationMs,
    normalizationPrompt: buildGeminiNormalizationPrompt(
      transcription.text,
      analysis,
      material,
    ),
  };
}
if (process.argv[1]?.endsWith("eval-station.ts")) {
  const folder = resolve(process.argv[2] ?? "fixtures/railway");
  const entries = await readdir(folder);
  const folders = entries.includes("transcription.json")
    ? [folder]
    : (await readdir(folder, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => join(folder, e.name));
  for (const fixture of folders) {
    const output = await evaluateFixture(fixture);
    const report = {
      fixture,
      stationMs: output.stationMs,
      candidates: output.correction.mentionEvidence.map((e) => ({
        id: e.mention.id,
        raw: e.mention.text,
        top: e.candidates[0]?.station.name,
        bound: e.candidates[0]?.bound,
      })),
      funnel: output.correction.funnel,
      metrics: output.correction.metrics,
      stationD1Reads: 0,
      stationD1Writes: 0,
    };
    console.log(JSON.stringify(report));
    if (process.argv.includes("--save"))
      await writeFile(
        join(fixture, "correction.json"),
        JSON.stringify(
          output,
          (_, v) => (v instanceof Map ? Object.fromEntries(v) : v),
          2,
        ) + "\n",
      );
  }
}
