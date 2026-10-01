import { describe, expect, it } from "vitest";
import { GeminiMetadataService } from "../src/metadata/gemini";
import type { AnnouncementAnalysis } from "../src/metadata/service";
import { buildSemanticRepresentation } from "../src/railway/semantic";
import { buildGeminiNormalizationPrompt } from "../src/metadata/prompt";
import {
  englishStationReading,
  stationEnglishName,
} from "../src/stations/language";
import { iseStations } from "./fixtures/stations";
const metadata = {
  station: null,
  line: null,
  trainType: null,
  trainName: null,
  trainNumber: null,
  destination: null,
  departureTime: null,
  arrivalTime: null,
  platform: null,
  nextStation: null,
  category: "other" as const,
  summary: null,
};
const raw =
  "ええ次は和倉温泉です。The next stop is Wakuda Onsen. もう一度和倉温泉です。";
const semantic = buildSemanticRepresentation(raw, []);
const analysis: AnnouncementAnalysis = {
  isTransitAnnouncement: true,
  mentions: [],
  metadata,
  semantic,
};
const envelope = (value: unknown) =>
  Response.json({
    candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }],
  });

describe("raw semantic normalized layers", () => {
  it("keeps Japanese and English as separate ordered source events", () => {
    expect(semantic.rawTranscription).toBe(raw);
    expect(semantic.events.map((e) => e.language)).toEqual(["ja", "en", "ja"]);
    expect(
      semantic.events
        .map((e) => raw.slice(e.sourceSpan.start, e.sourceSpan.end))
        .join(""),
    ).toBe(raw);
    expect(
      semantic.events.every(
        (e) => e.sourceOccurrenceCount === 1 && e.sourceSegmentIds.length > 0,
      ),
    ).toBe(true);
  });
  it("accepts free reconstruction and preserves event order regardless of model array order", async () => {
    const normalizedEvents = [
      {
        sourceEventId: semantic.events[2]!.id,
        language: "ja",
        text: "次は和倉温泉です。",
      },
      {
        sourceEventId: semantic.events[1]!.id,
        language: "en",
        text: "The next stop is Wakura Onsen.",
      },
      {
        sourceEventId: semantic.events[0]!.id,
        language: "ja",
        text: "まもなく和倉温泉に到着します。",
      },
    ];
    const result = await new GeminiMetadataService("key", "test", async () =>
      envelope({
        normalizedTranscription: "provider prose",
        normalizedEvents,
        entities: [],
      }),
    ).normalize(raw, analysis, []);
    expect(result.normalizedTranscription).toBe(
      "まもなく和倉温泉に到着します。\nThe next stop is Wakura Onsen.\n次は和倉温泉です。",
    );
    expect(semantic.rawTranscription).toBe(raw);
    expect(result.normalizationObservation.outcome).toBe("generated");
  });
  it("retains a missing English event locally without rejecting reconstructed Japanese prose", async () => {
    const normalizedEvents = [
      {
        sourceEventId: semantic.events[0]!.id,
        language: "ja",
        text: "次は和倉温泉です。",
      },
    ];
    const result = await new GeminiMetadataService("key", "test", async () =>
      envelope({
        normalizedTranscription: "次は和倉温泉です。",
        normalizedEvents,
        entities: [],
      }),
    ).normalize(raw, analysis, []);
    expect(result.normalizedTranscription).toContain(
      "The next stop is Wakuda Onsen.",
    );
    expect(result.normalizedTranscription).toContain("次は和倉温泉です。");
    expect(result.normalizationObservation.missingSourceEventIds).toContain(
      semantic.events[1]!.id,
    );
  });
  it("reports outside-evidence entities and unknown IDs without rejecting the model output", async () => {
    const result = await new GeminiMetadataService("key", "test", async () =>
      envelope({
        normalizedTranscription: "東京行きの電車は2番線から発車します。",
        entities: [
          {
            kind: "destination",
            sourceText: "安雪",
            sourceMentionId: "unknown",
            text: "東京",
          },
        ],
      }),
    ).normalize(
      "安雪。数字も崩れています。",
      { ...analysis, semantic: undefined } as unknown as AnnouncementAnalysis,
      [],
    );
    expect(result.normalizedTranscription).toBe(
      "東京行きの電車は2番線から発車します。",
    );
    expect(result.normalizationObservation.targetsOutsideEvidence).toEqual([
      "東京",
    ]);
    expect(result.normalizationObservation.unmatchedMentionIds).toEqual([
      "unknown",
    ]);
  });
  it("includes semantic context, source IDs and untrusted raw data in Gemini #2 material", () => {
    const prompt = buildGeminiNormalizationPrompt(raw, analysis, []);
    expect(prompt).toContain("semanticEvents");
    expect(prompt).toContain(semantic.events[1]!.id);
    expect(prompt).toContain("hard constraintではありません");
    expect(prompt).toContain("untrusted source text");
    expect(prompt).not.toContain("allowedTargets");
  });
  it("supports English station spellings without translating them into Japanese", () => {
    const station = {
      ...iseStations[0]!,
      name: "和倉温泉",
      kana: "わくらおんせん",
    };
    expect(stationEnglishName(station)).toBe("Wakura Onsen");
    expect(englishStationReading("Wakuda Onsen")).toBe("わくだおんせん");
  });
  it("keeps repeated announcements in raw with independent source identities", () => {
    const representation = buildSemanticRepresentation(
      "次は東京です。次は東京です。The next stop is Tokyo.",
      [],
    );
    expect(representation.events).toHaveLength(3);
    expect(new Set(representation.events.map((e) => e.id)).size).toBe(3);
    expect(representation.rawTranscription).toBe(
      "次は東京です。次は東京です。The next stop is Tokyo.",
    );
  });
});

import { assembleResult } from "../src/pipeline/result-assembly";
import { StationCorrectionEngine } from "../src/stations/correction-engine";
import { StaticRailwayRepository } from "../src/stations/static-repository";
import { railwayIndexes } from "../src/stations/static-data";
it("maps metadata by stable occurrence ID rather than exact entity sourceText", async () => {
  const mention = {
    id: "mention:0:2",
    text: "安雪",
    start: 0,
    end: 2,
    role: "destination" as const,
    sequenceId: 1,
    phoneticHint: "やす",
  };
  const first = {
    ...analysis,
    mentions: [mention],
    metadata: { ...metadata, destination: "安雪行き" },
  };
  const correction = await new StationCorrectionEngine(
    () => new StaticRailwayRepository(railwayIndexes),
  ).run({ transcription: "安雪行き", mentions: [mention], context: {} });
  const result = await new GeminiMetadataService("key", "test", async () =>
    envelope({
      normalizedTranscription: "野洲行きです。",
      entities: [
        {
          kind: "destination",
          sourceMentionId: mention.id,
          sourceText: "安雪行き",
          text: "野洲",
        },
        {
          kind: "train_name",
          sourceMentionId: mention.id,
          sourceText: "安雪",
          text: "別の列車",
        },
      ],
    }),
  ).normalize("安雪行き", first, []);
  expect(
    assembleResult(first, correction, result, "raw.ogg").metadata.destination,
  ).toBe("野洲");
  expect(first.metadata.destination).toBe("安雪行き");
});

import { attachSpeechSegmentProvenance } from "../src/railway/semantic";
it("attaches speech time ranges without deleting either language", () => {
  const source = buildSemanticRepresentation(
    "次は東京です。The next stop is Tokyo.",
    [],
  );
  const result = attachSpeechSegmentProvenance(source, [
    { startSec: 0, endSec: 3, text: "次は東京です。" },
    { startSec: 4, endSec: 7, text: "The next stop is Tokyo." },
  ]);
  expect(result.events.map((e) => e.sourceTimeRange)).toEqual([
    { startSec: 0, endSec: 3 },
    { startSec: 4, endSec: 7 },
  ]);
  expect(result.events.map((e) => e.language)).toEqual(["ja", "en"]);
  expect(result.rawTranscription).toBe(source.rawTranscription);
});
