import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateFixture } from "../scripts/eval-station";
import { railwayStaticData, railwayIndexes } from "../src/stations/static-data";
import { assertRailwayDataIntegrity } from "../src/stations/static-schema";
import { StaticRailwayRepository } from "../src/stations/static-repository";
describe("offline fixture railway evaluation", () => {
  it("validates all master IDs, ordered paths and connections", () =>
    expect(() => assertRailwayDataIntegrity(railwayStaticData)).not.toThrow());
  it("evaluates recorded-shape fixtures without any external API or database", async () => {
    for (const entry of await readdir("fixtures/railway")) {
      const folder = join("fixtures/railway", entry);
      const result = await evaluateFixture(folder);
      const expected = JSON.parse(
        await readFile(join(folder, "expected.json"), "utf8"),
      );
      if (expected.topCandidates)
        expect(
          result.correction.mentionEvidence.map(
            (e) => e.candidates[0]?.station.name,
          ),
          entry,
        ).toEqual(expected.topCandidates);
      expect(result.semantic!.rawTranscription).toBe(result.raw);
      const transcription = JSON.parse(
        await readFile(join(folder, "transcription.json"), "utf8"),
      );
      if (transcription.segments?.length)
        expect(result.semantic!.sourceSegments!.map((s) => s.text)).toEqual(
          transcription.segments.map((s: { text: string }) => s.text),
        );
      else
        expect(
          result.semantic!.sourceSegments!.map((s) => s.text).join(""),
        ).toBe(result.raw);
      expect(
        result.correction.metrics.sequences.every(
          (s) => s.d1QueryCount === 0 && s.d1RowsRead === 0,
        ),
      ).toBe(true);
      expect(result.normalizationPrompt).toContain("semanticEvents");
    }
  });
  it("retains transfer graph fallback in both directions", async () => {
    const repository = new StaticRailwayRepository(railwayIndexes);
    const routes = await repository.findRouteCandidates(
      ["河和口", "中部国際空港"],
      3,
    );
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0]!.transferCount).toBeGreaterThan(0);
    expect(
      (await repository.findRouteCandidates(["中部国際空港", "河和口"], 3))
        .length,
    ).toBeGreaterThan(0);
  });
});
