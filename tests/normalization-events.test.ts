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
  it("adopts provider prose unchanged regardless of debug event array order", async () => {
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
    expect(result.normalizedTranscription).toBe("provider prose");
    expect(result.normalizedEvents).toEqual(normalizedEvents);
    expect(semantic.rawTranscription).toBe(raw);
    expect(result.normalizationObservation.outcome).toBe("generated");
  });
  it("observes missing debug events without inserting raw text into provider prose", async () => {
    const normalizedEvents = [
      {
        sourceEventId: semantic.events[0]!.id,
        language: "ja",
        text: "次は和倉温泉です。",
      },
    ];
    const result = await new GeminiMetadataService("key", "test", async () =>
      envelope({
        normalizedTranscription:
          "次は和倉温泉です。The next stop is Wakura Onsen.",
        normalizedEvents,
        entities: [],
      }),
    ).normalize(raw, analysis, []);
    expect(result.normalizedTranscription).toBe(
      "次は和倉温泉です。The next stop is Wakura Onsen.",
    );
    expect(result.normalizedEvents).toEqual(normalizedEvents);
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
import { assembleNormalizedMetadata } from "../src/railway/result-metadata";
import { StationCorrectionEngine } from "../src/stations/correction-engine";
import { StaticRailwayRepository } from "../src/stations/static-repository";
import { railwayIndexes } from "../src/stations/static-data";
describe("metadata derived from the normalized document", () => {
  const source = "サンダーバード17号、和倉温泉行きです。次は鶴ヶです。";
  const mention = {
    id: "mention:26:28",
    text: "鶴ヶ",
    start: source.indexOf("鶴ヶ"),
    end: source.indexOf("鶴ヶ") + 2,
    role: "stop" as const,
    sequenceId: 1,
    phoneticHint: "つるが",
  };
  const draft: AnnouncementAnalysis = {
    isTransitAnnouncement: true,
    mentions: [mention],
    metadata: {
      ...metadata,
      trainName: "サンダーバード",
      trainNumber: "17号",
      trainType: "特急",
      destination: "和倉温泉",
      departureTime: "11:10",
      platform: "0番乗り場",
      nextStation: "鶴ヶ",
      summary: "鶴ヶに停車する特急",
    },
  };
  it("uses Gemini #2 metadata for the filename and summary even when entities are absent", async () => {
    const finalText = source.replace("鶴ヶ", "敦賀");
    const finalMetadata = {
      ...draft.metadata,
      nextStation: "敦賀",
      summary: "敦賀に停車する特急",
    };
    const normalized = await new GeminiMetadataService(
      "key",
      "test",
      async () =>
        envelope({
          normalizedTranscription: finalText,
          metadata: finalMetadata,
          entities: [],
        }),
    ).normalize(source, draft, []);
    const correction = await new StationCorrectionEngine(
      () => new StaticRailwayRepository(railwayIndexes),
    ).run({ transcription: source, mentions: draft.mentions, context: {} });
    const result = assembleResult(draft, correction, normalized, "source.mp3");
    expect(result.filename).toBe(
      "サンダーバード_17号_特急_和倉温泉行き_11時10分発_0番乗り場_次は敦賀.mp3",
    );
    expect(result.metadata.summary).toBe("敦賀に停車する特急");
    expect(normalized.normalizedTranscription).toBe(finalText);
    expect(draft.metadata.nextStation).toBe("鶴ヶ");
    expect(draft.metadata.summary).toBe("鶴ヶに停車する特急");
  });
  it("maps an older response without IDs into matching nextStation and summary fields", () => {
    const result = assembleNormalizedMetadata(
      draft,
      undefined,
      [{ kind: "station", sourceText: "鶴ヶ", text: "敦賀" }],
      null,
    );
    expect(result.nextStation).toBe("敦賀");
    expect(result.summary).toBe("敦賀に停車する特急");
  });
  it("does not apply unrelated entities or invalid occurrence IDs to draft metadata", () => {
    const result = assembleNormalizedMetadata(
      draft,
      undefined,
      [
        {
          kind: "train_name",
          sourceMentionId: mention.id,
          sourceText: "鶴ヶ",
          text: "東京",
        },
        {
          kind: "station",
          sourceMentionId: "missing",
          sourceText: "鶴ヶ",
          text: "東京",
        },
      ],
      null,
    );
    expect(result.nextStation).toBe("鶴ヶ");
    expect(result.summary).toBe(draft.metadata.summary);
  });
  it("honours explicit nulls in final metadata instead of restoring old values", () => {
    const result = assembleNormalizedMetadata(
      draft,
      { nextStation: null, summary: null, trainNumber: null },
      [
        {
          kind: "station",
          sourceMentionId: mention.id,
          sourceText: "鶴ヶ",
          text: "敦賀",
        },
      ],
      null,
    );
    expect(result.nextStation).toBeNull();
    expect(result.summary).toBeNull();
    expect(result.trainNumber).toBeNull();
  });
  it("keeps successful prose when auxiliary metadata is malformed", async () => {
    const finalText = source.replace("鶴ヶ", "敦賀");
    const normalized = await new GeminiMetadataService(
      "key",
      "test",
      async () =>
        envelope({
          normalizedTranscription: finalText,
          metadata: { nextStation: 42 },
          entities: [],
        }),
    ).normalize(source, draft, []);
    expect(normalized.normalizedTranscription).toBe(finalText);
    expect(normalized.normalizationObservation.outcome).toBe("generated");
  });
  it("asks for final metadata and a summary based on the corrected document", () => {
    expect(buildGeminiNormalizationPrompt(source, draft, [])).toContain(
      "入力のmetadataは補正前の下書き",
    );
    expect(buildGeminiNormalizationPrompt(source, draft, [])).toContain(
      "summaryも補正後の名称",
    );
  });
});
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

import speechFixture from "../fixtures/railway/J-event-assembly/transcription.json";
import annotationFixture from "../fixtures/railway/J-event-assembly/analysis.json";
import normalizedFixture from "../fixtures/railway/J-event-assembly/normalized.json";
import type { SemanticEventProposal } from "../src/railway/semantic";

describe("mid-word semantic annotation regression", () => {
  const proposals = annotationFixture.events as SemanticEventProposal[];
  it("uses complete Whisper segments and lets several annotations share a segment", () => {
    const representation = attachSpeechSegmentProvenance(
      buildSemanticRepresentation(speechFixture.text, [], proposals),
      speechFixture.segments,
    );
    expect(representation.rawTranscription).toBe(speechFixture.text);
    expect(representation.sourceSegments?.map((s) => s.text)).toEqual(
      speechFixture.segments.map((s) => s.text),
    );
    expect(representation.sourceSegments?.map((s) => s.id)).toEqual([
      "speech-segment:0",
      "speech-segment:1",
      "speech-segment:2",
    ]);
    const firstEvents = representation.events.filter(
      (e) => e.sourceSegmentIds[0] === "speech-segment:0",
    );
    expect(firstEvents).toHaveLength(2);
    expect(
      firstEvents.map((e) =>
        speechFixture.text.slice(e.sourceSpan.start, e.sourceSpan.end),
      ),
    ).toEqual([
      speechFixture.segments[0]!.text,
      speechFixture.segments[0]!.text,
    ]);
    expect(representation.events.map((e) => e.language)).toEqual([
      "ja",
      "ja",
      "en",
      "ja",
    ]);
    expect(
      representation.events.map((e) => e.sourceTimeRange?.startSec),
    ).toEqual([0, 0, 12, 20]);
  });
  it("never splits text-only sources at Gemini offsets", () => {
    const representation = buildSemanticRepresentation(
      speechFixture.text,
      [],
      proposals,
    );
    const sourceSpans = buildSemanticRepresentation(
      speechFixture.text,
      [],
    ).sourceSegments!.map((s) => s.sourceSpan);
    expect(representation.sourceSegments!.map((s) => s.sourceSpan)).toEqual(
      sourceSpans,
    );
    expect(
      representation.events.every((e) =>
        sourceSpans.some(
          (s) => s?.start === e.sourceSpan.start && s.end === e.sourceSpan.end,
        ),
      ),
    ).toBe(true);
  });
  it("keeps Gemini #2's document verbatim even when debug events are incomplete fragments", async () => {
    const semantic = buildSemanticRepresentation(
      speechFixture.text,
      [],
      proposals,
      speechFixture.segments,
    );
    const first = { ...analysis, semantic };
    const result = await new GeminiMetadataService("key", "test", async () =>
      envelope(normalizedFixture),
    ).normalize(speechFixture.text, first, []);
    expect(result.normalizedTranscription).toBe(
      normalizedFixture.normalizedTranscription,
    );
    expect(result.normalizedEvents).toEqual(normalizedFixture.normalizedEvents);
    expect(result.normalizationObservation.missingSourceEventIds).toEqual(
      semantic.events.map((e) => e.id),
    );
    expect(result.normalizedTranscription).not.toContain(
      "し\n。\n3. Pl\ne\nthrough.",
    );
    expect(first.semantic.rawTranscription).toBe(speechFixture.text);
  });
});

it("keeps whitespace in nonempty provider prose instead of transforming the document", async () => {
  const prose = "\n 日本語の案内です。\nEnglish announcement. \n";
  const result = await new GeminiMetadataService("key", "test", async () =>
    envelope({
      normalizedTranscription: prose,
      normalizedEvents: [],
      entities: [],
    }),
  ).normalize(raw, analysis, []);
  expect(result.normalizedTranscription).toBe(prose);
});

it("keeps ja/en/zh/ko source segments and adopts the complete multilingual provider body", async () => {
  const blocks = [
    "まもなく発車します。",
    "The train is departing.",
    "列车即将出发。",
    "열차가 출발합니다.",
  ];
  const source = blocks.join("\n");
  const representation = buildSemanticRepresentation(
    source,
    [],
    [],
    blocks.map((text, i) => ({ text, startSec: i * 10, endSec: i * 10 + 8 })),
  );
  const input = { ...analysis, semantic: representation };
  expect(representation.events.map((e) => e.language)).toEqual([
    "ja",
    "en",
    "zh",
    "ko",
  ]);
  expect(representation.sourceSegments!.map((s) => s.text)).toEqual(blocks);
  const body =
    "発車いたします。\nThe train will depart.\n列车即将出发。\n열차가 곧 출발합니다.";
  const result = await new GeminiMetadataService(
    "key",
    "test",
    async (_url, init) => {
      const request = JSON.parse(init!.body as string);
      expect(JSON.stringify(request)).toContain("中国語(zh)");
      expect(JSON.stringify(request)).toContain("韓国語(ko)");
      return envelope({
        normalizedTranscription: body,
        normalizedEvents: representation.events.map((e, i) => ({
          sourceEventId: e.id,
          language: e.language,
          text: blocks[i],
        })),
        entities: [],
      });
    },
  ).normalize(source, input, []);
  expect(result.normalizedTranscription).toBe(body);
  expect(result.normalizationObservation.missingLanguages).toEqual([]);
  expect(representation.rawTranscription).toBe(source);
});

it("observes lost languages without raw-slice insertion or rejection", async () => {
  const source =
    "次は京都です。Next stop Kyoto. 下一站京都。다음 역은 교토입니다.";
  const input = {
    ...analysis,
    semantic: buildSemanticRepresentation(source, []),
  };
  const result = await new GeminiMetadataService("key", "test", async () =>
    envelope({ normalizedTranscription: "次は京都です。", entities: [] }),
  ).normalize(source, input, []);
  expect(result.normalizedTranscription).toBe("次は京都です。");
  expect(result.normalizationObservation.missingLanguages).toEqual(
    expect.arrayContaining(["en", "zh", "ko"]),
  );
});
