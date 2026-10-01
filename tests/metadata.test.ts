import { describe, expect, it } from "vitest";
import {
  applyNormalizedEntitiesToMetadata,
  GeminiApiError,
  GeminiMetadataService,
  GeminiRequestTimeoutError,
  checkNormalization,
  isRetryableGeminiError,
} from "../src/metadata/gemini";
import { z } from "zod";
import { buildGeminiAnalysisPrompt } from "../src/metadata/analysis-prompt";
import { buildGeminiNormalizationPrompt, type StopSequenceContext } from "../src/metadata/prompt";
import {
  GeminiAnalysisSchema,
  GeminiNormalizationSchema,
  geminiAnalysisJsonSchema,
  geminiNormalizationJsonSchema,
} from "../src/metadata/schema";
import type { AnnouncementAnalysis, StationMention } from "../src/metadata/service";
import { generateRailwayFilename } from "../src/railway/filename";
import type { Station } from "../src/stations/types";

const validAnalysisOutput = {
  isTransitAnnouncement: true,
  mentions: [
    { text: "五十鈴ヶ丘", start: 2, end: 7, role: "next_stop", sequenceId: null },
  ],
  station: null,
  line: "JR参宮線",
  trainType: null,
  trainName: null,
  trainNumber: null,
  destination: null,
  departureTime: "13:25",
  arrivalTime: null,
  platform: null,
  nextStation: "五十鈴ヶ丘",
  category: "general_information",
  summary: "次は五十鈴ヶ丘",
} as const;

const analysis: AnnouncementAnalysis = {
  isTransitAnnouncement: true,
  mentions: [],
  metadata: {
    station: null,
    line: "JR参宮線",
    trainType: null,
    trainName: null,
    trainNumber: null,
    destination: null,
    departureTime: "13:25",
    arrivalTime: null,
    platform: null,
    nextStation: null,
    category: "general_information",
    summary: "案内",
  },
};

function station(id: number, name: string): Station {
  return {
    id, name, kana: null, kanaSource: null, operatorName: null, lineName: "JR土讃線",
    prefecture: null, prevStation: null, nextStation: null,
    longitude: null, latitude: null, postal: null,
  };
}

function routeSupportedSequence(
  pairs: readonly (readonly [string, string])[],
  routeStationNames: readonly string[] = [],
): {
  analysis: AnnouncementAnalysis;
  sequences: StopSequenceContext[];
} {
  const mentions: StationMention[] = pairs.map(([raw], index) => ({
    text: raw, start: null, end: null, role: "stop", sequenceId: 1,
  }));
  const stations = pairs.map(([, target], index) => station(index + 1, target));
  const routeStations = routeStationNames.length === 0
    ? stations
    : routeStationNames.map((name, index) => station(pairs.length + index + 1, name));
  return {
    analysis: { ...analysis, mentions },
    sequences: [{
      id: 1,
      role: "stops",
      mentions,
      contextMentions: [],
      stationCandidates: [],
      mentionCandidates: pairs.map(([raw], index) => [{
        mentionIndex: index,
        mentionText: raw,
        station: stations[index]!,
        nameSimilarity: raw === stations[index]!.name ? 1 : 0.45,
        kanaSimilarity: raw === stations[index]!.name ? 1 : 0.45,
        phoneticSimilarity: 0,
        bound: false,
        lexicalScore: raw === stations[index]!.name ? 1 : 0.45,
        matchStrength: raw === stations[index]!.name ? "hard" : "soft",
        routeHypothesisIds: [0],
        bestRouteScore: 0.9,
        finalScore: 0.8,
      }]),
      routeHypotheses: [{
        stations: routeStations.map((candidate, routeIndex) => ({ station: candidate, routeIndex })),
        anchorCoverage: 1,
        orderConsistency: 1,
        transferCount: 0,
        pathLength: stations.length,
        score: 0.9,
      }],
    }],
  };
}

const geminiEnvelope = (value: unknown): Response => Response.json({
  candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }],
});

describe("two-stage Gemini metadata boundary", () => {
  it("validates the separate analysis and normalization schemas", () => {
    expect(GeminiAnalysisSchema.parse(validAnalysisOutput).departureTime).toBe("13:25");
    expect(() => GeminiAnalysisSchema.parse({ ...validAnalysisOutput, departureTime: "1:25" })).toThrow();
    expect(() => GeminiAnalysisSchema.parse({ ...validAnalysisOutput, station: "架空駅" })).toThrow();
    expect(() => GeminiNormalizationSchema.parse({ normalizedTranscription: "  " })).toThrow();
    expect(() => GeminiNormalizationSchema.parse({ normalizedTranscription: "次は高松です" })).toThrow();
    expect(geminiAnalysisJsonSchema.properties.mentions.type).toBe("array");
    expect(geminiNormalizationJsonSchema.properties.normalizedTranscription.minLength).toBe(1);
    expect(geminiNormalizationJsonSchema.required).toContain("entities");
  });

  it("makes Gemini #1 analysis-only and Gemini #2 sequence-constrained", () => {
    const firstPrompt = buildGeminiAnalysisPrompt("名鉄一宮行きです。A、B、Cの順に止まります。");
    expect(firstPrompt).toContain("文字起こしを一切補正しません");
    expect(firstPrompt).toContain("textは必ずtranscriptionに実在する連続部分");
    expect(firstPrompt).toContain("destination");
    expect(firstPrompt).toContain("sequenceId");
    expect(firstPrompt).toContain("A、B、C方面");
    expect(firstPrompt).toContain("複数mentionからなるdirection列には必ずsequenceId");

    const secondPrompt = buildGeminiNormalizationPrompt("A、B、C", analysis, []);
    expect(secondPrompt).toContain("役割別sequenceごと");
    expect(secondPrompt).toContain("文法的な崩れ、重複、不自然な助詞");
    expect(secondPrompt).toContain("候補経路だけを根拠に停車駅列全体を再構成しない");
    expect(secondPrompt).toContain("destination、direction、transfer、stop");
    expect(secondPrompt).toContain("exact matchでも");
    expect(secondPrompt).toContain("長大な迂回経路");
    expect(secondPrompt).toContain("補正を支持する「証拠」");
    expect(secondPrompt).toContain("採用必須の制約や答えではない");
    expect(secondPrompt).toContain("固有名詞は、経路上に存在するという理由だけで変更しない");
  });

  it("passes direction and destination context to full-transcription normalization", () => {
    const directionMentions = [
      { text: "伊野", start: 0, end: 2, role: "direction" as const, sequenceId: 1 },
      { text: "佐川", start: 3, end: 5, role: "direction" as const, sequenceId: 1 },
      { text: "須崎", start: 6, end: 8, role: "direction" as const, sequenceId: 1 },
    ];
    const destination = {
      text: "久保川", start: 15, end: 18, role: "destination" as const, sequenceId: null,
    };
    const prompt = buildGeminiNormalizationPrompt(
      "伊野、佐川、須崎方面、久保川行き",
      { ...analysis, mentions: [...directionMentions, destination] },
      [{
        id: 1,
        role: "direction",
        mentions: directionMentions,
        contextMentions: [destination],
        stationCandidates: [],
        mentionCandidates: [],
        routeHypotheses: [],
      }],
    );

    expect(prompt).toContain('"role":"direction"');
    expect(prompt).toContain('"contextMentions":[{"text":"久保川","role":"destination"}]');
    expect(prompt).toContain("normalizedTranscriptionを生成");
  });

  it("keeps only verbatim Gemini #1 mentions and preserves their spoken order", async () => {
    const transcription = "名鉄一宮行きです。神話口、福岐の順に止まります。";
    const fetcher = async (): Promise<Response> => geminiEnvelope({
      ...validAnalysisOutput,
      destination: "名鉄一宮",
      mentions: [
        { text: "名鉄一宮", start: null, end: null, role: "destination", sequenceId: null },
        { text: "神宮前", start: null, end: null, role: "stop", sequenceId: 1 },
        { text: "神話口", start: null, end: null, role: "stop", sequenceId: 1 },
        { text: "福岐", start: null, end: null, role: "stop", sequenceId: 1 },
      ],
    });

    const result = await new GeminiMetadataService("secret", "gemini-test", fetcher).analyze(transcription);

    expect(result.mentions.map(({ text, role, sequenceId }) => ({ text, role, sequenceId }))).toEqual([
      { text: "名鉄一宮", role: "destination", sequenceId: null },
      { text: "神話口", role: "stop", sequenceId: 1 },
      { text: "福岐", role: "stop", sequenceId: 1 },
    ]);
    expect(result.mentions.every(({ text }) => transcription.includes(text))).toBe(true);
  });

  it("falls back to raw text when Gemini #2 returns an empty normalized value", async () => {
    const fetcher = async (): Promise<Response> => geminiEnvelope({ normalizedTranscription: "", entities: [] });
    const result = await new GeminiMetadataService("secret", "gemini-test", fetcher)
      .normalize("補正前の駅放送", analysis, []);
    expect(result.normalizedTranscription).toBe("補正前の駅放送");
    expect(result.normalizationGuard).toMatchObject({
      accepted: false,
      risk: "high",
      reason: "empty_output",
    });
  });

  it("falls back to raw text when Gemini #2 returns malformed JSON", async () => {
    const fetcher = async (): Promise<Response> => Response.json({
      candidates: [{ content: { parts: [{ text: "{not-json" }] } }],
    });
    const result = await new GeminiMetadataService("secret", "gemini-test", fetcher)
      .normalize("補正前の駅放送", analysis, []);
    expect(result.normalizedTranscription).toBe("補正前の駅放送");
    expect(result.normalizationGuard).toMatchObject({
      accepted: false,
      risk: "high",
      reason: "invalid_output",
    });
  });

  it("keeps a constrained Gemini rewrite while reporting unsupported corrections", async () => {
    const transcription = "2番線に電車か参ります黄色い線までお下かりください名鉄名古屋神宮方面の普通名鉄一宮行き神話口福岐千田竹豊上青山奈良は千田半田の順に止まり千田半田から快速急行に変わり集落園にも止まります";
    const overcorrected = "まもなく2番線に電車が参ります。黄色い線までお下がりください。名鉄名古屋、神宮前方面の普通、名鉄一宮行きです。神宮前、堀田、伝馬、大江、大同町、柴田、聚楽園の順に止まります。聚楽園から快速急行に変わり、太田川にも止まります。";
    const fetcher = async (): Promise<Response> => geminiEnvelope({ normalizedTranscription: overcorrected, entities: [] });
    const result = await new GeminiMetadataService("secret", "gemini-test", fetcher)
      .normalize(transcription, analysis, []);

    expect(result.normalizedTranscription).toBe(overcorrected);
    expect(result.normalizationGuard).toMatchObject({
      accepted: true,
      risk: "medium",
      reason: "unsupported_non_entity_rewrite",
    });
    expect(result.normalizationGuard.similarity).toBeLessThan(0.72);
    expect(result.diagnostics.responseText).toContain(overcorrected);
  });

  it("accepts a localized correction in a long announcement", async () => {
    const transcription = `まもなく列車が到着します。${"案内をよくお聞きください。".repeat(5)}黄色い展示ブロックまでお下がりください。`;
    const corrected = transcription.replace("黄色い展示ブロック", "黄色い点字ブロック");
    const fetcher = async (): Promise<Response> => geminiEnvelope({ normalizedTranscription: corrected, entities: [] });
    const result = await new GeminiMetadataService("secret", "gemini-test", fetcher)
      .normalize(transcription, analysis, []);

    expect(result.normalizedTranscription).toBe(corrected);
    expect(result.normalizationGuard.reason).toBe("accepted");
  });

  it("accepts the Shikoku announcement as route-supported entity corrections", () => {
    const raw = "特急、島本6号、高松行きの電車駅は、5面、戸佐山、大杉、大桶、阿波池田、小戸屋、禅津、丸溜、板津、坂井出、終点、高松です。 特急、南風24号、岡山行きの電車駅は、2月で分かれて、小島、終点、岡山です。";
    const corrected = "特急しまんと6号、高松行きの停車駅は、土佐山田、大杉、大歩危、阿波池田、琴平、善通寺、丸亀、多度津、坂出、終点、高松です。特急南風24号、岡山行きの停車駅は、児島、終点、岡山です。";
    const context = routeSupportedSequence([
      ["戸佐山", "土佐山田"], ["大杉", "大杉"], ["大桶", "大歩危"], ["阿波池田", "阿波池田"],
      ["小戸屋", "琴平"], ["禅津", "善通寺"], ["丸溜", "丸亀"], ["板津", "多度津"],
      ["坂井出", "坂出"], ["高松", "高松"], ["小島", "児島"], ["岡山", "岡山"],
    ]);

    const guard = checkNormalization(raw, corrected, context.analysis, context.sequences, [
      { text: "しまんと6号", kind: "train_name", sourceText: "島本6号" },
      ...[
        ["土佐山田", "戸佐山"], ["大杉", "大杉"], ["大歩危", "大桶"], ["阿波池田", "阿波池田"],
        ["琴平", "小戸屋"], ["善通寺", "禅津"], ["丸亀", "丸溜"], ["多度津", "板津"],
        ["坂出", "坂井出"], ["高松", "高松"], ["児島", "小島"], ["岡山", "岡山"],
      ].map(([text, sourceText]) => ({ text: text!, kind: "station" as const, sourceText: sourceText! })),
    ]);

    expect(guard).toMatchObject({
      accepted: true,
      reason: "route_supported_entity_corrections",
      supportedEntityCorrections: 8,
      unsupportedEntityCorrections: 0,
    });
    expect(guard.globalSimilarity).toBeCloseTo(0.6233766233766234);
    expect(guard.nonEntitySimilarity).toBeGreaterThanOrEqual(0.78);
    expect(guard.unsupportedEntities).toEqual([]);
  });

  it("rejects newly invented operational facts even when the surrounding sentence is similar", () => {
    const raw = "この列車は高松行きです。まもなく発車します。";
    const corrected = "この列車は高松行きです。18時45分に3番線から発車します。岡山駅で快速列車にお乗り換えください。";
    const guard = checkNormalization(raw, corrected, analysis, []);

    expect(guard).toMatchObject({ accepted: false, reason: "unsupported_factual_addition" });
  });

  it("warns about a station unsupported by candidate or route context without discarding the rewrite", () => {
    const raw = "この列車の停車駅は、戸佐山、大桶、小戸屋の順に止まります。";
    const corrected = "この列車の停車駅は、土佐山田、大歩危、琴平、架空中央の順に止まります。";
    const context = routeSupportedSequence([
      ["戸佐山", "土佐山田"], ["大桶", "大歩危"], ["小戸屋", "琴平"],
    ]);

    expect(checkNormalization(raw, corrected, context.analysis, context.sequences, [{
      text: "架空中央", kind: "station", sourceText: "戸佐山",
    }])).toMatchObject({
      accepted: true,
      risk: "medium",
      reason: "unsupported_entity_insertion",
      unsupportedEntities: ["架空中央"],
      warnings: [{ type: "unsupported_entity_correction", entities: ["架空中央"] }],
    });
  });

  it("allows additional stations when route context supports them", () => {
    const raw = "この列車の停車駅は、戸佐山、大桶、小戸屋の順に止まります。";
    const corrected = "この列車の停車駅は、土佐山田、大杉、大歩危、阿波池田、琴平の順に止まります。";
    const context = routeSupportedSequence([
      ["戸佐山", "土佐山田"], ["大桶", "大歩危"], ["小戸屋", "琴平"],
    ], ["土佐山田", "大杉", "大歩危", "阿波池田", "琴平"]);
    const normalizedEntities = ["土佐山田", "大杉", "大歩危", "阿波池田", "琴平"]
      .map((text) => ({ text, kind: "station" as const, sourceText: null }));

    expect(checkNormalization(
      raw,
      corrected,
      context.analysis,
      context.sequences,
      normalizedEntities,
    )).toMatchObject({
      accepted: true,
      unsupportedEntities: [],
    });
  });

  it("accepts several supported station corrections when sentence structure is preserved", () => {
    const raw = "この列車の停車駅は、戸佐山、大桶、小戸屋、禅津、丸溜、板津、坂井出の順です。案内をよくお聞きください。";
    const corrected = "この列車の停車駅は、土佐山田、大歩危、琴平、善通寺、丸亀、多度津、坂出の順です。案内をよくお聞きください。";
    const context = routeSupportedSequence([
      ["戸佐山", "土佐山田"], ["大桶", "大歩危"], ["小戸屋", "琴平"], ["禅津", "善通寺"],
      ["丸溜", "丸亀"], ["板津", "多度津"], ["坂井出", "坂出"],
    ]);

    expect(checkNormalization(raw, corrected, context.analysis, context.sequences)).toMatchObject({
      accepted: true,
      supportedEntityCorrections: 7,
      unsupportedEntityCorrections: 0,
    });
  });

  it("falls back for an unrelated rewrite of non-entity prose", async () => {
    const raw = "まもなく列車が到着します。危険ですので黄色い点字ブロックまでお下がりください。車内では携帯電話をマナーモードにしてください。";
    const corrected = "本日は晴天です。駅前広場では地域のお祭りを開催しています。飲食店や観光案内所も営業していますので、どうぞごゆっくりお楽しみください。";
    const guard = checkNormalization(raw, corrected, analysis, []);

    expect(guard.accepted).toBe(false);
    expect(guard.reason).toBe("unrelated_rewrite");
    expect(guard.risk).toBe("high");
    expect(guard.nonEntitySimilarity).toBeLessThan(0.78);

    const fetcher = async (): Promise<Response> => geminiEnvelope({
      normalizedTranscription: corrected,
      entities: [],
    });
    const result = await new GeminiMetadataService("secret", "gemini-test", fetcher)
      .normalize(raw, analysis, []);
    expect(result.normalizedTranscription).toBe(raw);
  });

  it("prefers an official destination candidate and keeps ordinary prose corrections", async () => {
    const raw = "普通列車、ワンマン、岩大津行きとなります。電池ブロックまでお下がりください。一両平成です。";
    const corrected = "普通列車、ワンマン、伊予大洲行きとなります。点字ブロックまでお下がりください。一両編成です。";
    const context = routeSupportedSequence([["岩大津", "伊予大洲"]]);
    context.analysis.mentions[0] = { ...context.analysis.mentions[0]!, role: "destination" };
    context.sequences[0] = { ...context.sequences[0]!, role: "destination" };
    const prompt = buildGeminiNormalizationPrompt(raw, context.analysis, context.sequences);
    expect(prompt).toContain('"rawMention":"岩大津"');
    expect(prompt).toContain('"stationName":"伊予大洲"');
    expect(prompt).toContain("候補外の似た中間的名称を独自生成しない");
    expect(prompt).toContain("伊予大津");

    const fetcher = async (): Promise<Response> => geminiEnvelope({
      normalizedTranscription: corrected,
      entities: [{ text: "伊予大洲", kind: "destination", sourceText: "岩大津" }],
    });
    const result = await new GeminiMetadataService("secret", "gemini-test", fetcher)
      .normalize(raw, context.analysis, context.sequences);

    expect(result.normalizedTranscription).toBe(corrected);
    expect(result.entities).toEqual([
      { text: "伊予大洲", kind: "destination", sourceText: "岩大津" },
    ]);
    expect(result.normalizationGuard.accepted).toBe(true);
    expect(result.normalizationGuard.unsupportedEntities).toEqual([]);

    const correctedMetadata = applyNormalizedEntitiesToMetadata({
      ...analysis.metadata,
      destination: "岩大津",
    }, result.entities);
    expect(correctedMetadata.destination).toBe("伊予大洲");
    expect(generateRailwayFilename(correctedMetadata, "recording.mp3")).toContain("伊予大洲行き");
  });

  it("does not treat a normalized stop as the recording station", () => {
    const metadata = applyNormalizedEntitiesToMetadata(analysis.metadata, [{
      text: "伊予大洲", kind: "station", sourceText: "岩大津",
    }]);
    expect(metadata).toEqual(analysis.metadata);
  });

  it("does not discard useful prose correction for one unsupported entity", async () => {
    const raw = "普通列車、ワンマン、岩大津行きです。電池ブロックまでお下がりください。一両平成です。";
    const corrected = "普通列車、ワンマン、伊予大津行きです。点字ブロックまでお下がりください。一両編成です。";
    const fetcher = async (): Promise<Response> => geminiEnvelope({
      normalizedTranscription: corrected,
      entities: [{ text: "伊予大津", kind: "destination", sourceText: "岩大津" }],
    });
    const result = await new GeminiMetadataService("secret", "gemini-test", fetcher)
      .normalize(raw, analysis, []);

    expect(result.normalizedTranscription).toBe(corrected);
    expect(result.normalizationGuard).toMatchObject({
      accepted: true,
      risk: "medium",
      reason: "unsupported_entity_insertion",
      unsupportedEntities: ["伊予大津"],
    });
  });

  it("preserves Gemini HTTP error details", async () => {
    const fetcher = async (): Promise<Response> => new Response(
      '{"error":{"message":"API key not valid"}}',
      { status: 400 },
    );
    const service = new GeminiMetadataService("invalid", "gemini-test", fetcher);
    await expect(service.analyze("test")).rejects.toEqual(new GeminiApiError(
      400,
      '{"error":{"message":"API key not valid"}}',
    ));
  });

  it("aborts a Gemini request that exceeds its deadline", async () => {
    let signal: AbortSignal | undefined;
    const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      signal = init?.signal ?? undefined;
      return await new Promise<Response>(() => {});
    };
    const service = new GeminiMetadataService("secret", "gemini-test", fetcher, 5);
    await expect(service.analyze("test")).rejects.toEqual(new GeminiRequestTimeoutError(5));
    expect(signal?.aborted).toBe(true);
  });

  it("uses strict safety settings and reports blocked prompt categories", async () => {
    let requestBody: unknown;
    const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        promptFeedback: {
          blockReason: "SAFETY",
          safetyRatings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "LOW", blocked: true }],
        },
      });
    };
    const service = new GeminiMetadataService("secret", "gemini-test", fetcher);
    await expect(service.analyze("unsafe")).rejects.toMatchObject({
      name: "GeminiSafetyBlockedError",
      blockedCategories: ["HARM_CATEGORY_DANGEROUS_CONTENT"],
    });
    expect(requestBody).toMatchObject({
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_LOW_AND_ABOVE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_LOW_AND_ABOVE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_LOW_AND_ABOVE" },
      ],
    });
  });

  it("reports a safety-blocked response without requiring response content", async () => {
    const fetcher = async (): Promise<Response> => Response.json({
      candidates: [{
        finishReason: "SAFETY",
        safetyRatings: [{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", probability: "MEDIUM", blocked: true }],
      }],
    });
    await expect(new GeminiMetadataService("secret", "gemini-test", fetcher).analyze("unsafe"))
      .rejects.toMatchObject({
        name: "GeminiSafetyBlockedError",
        blockedCategories: ["HARM_CATEGORY_SEXUALLY_EXPLICIT"],
      });
  });

  it("retries temporary Gemini failures but not deterministic client errors", () => {
    expect(isRetryableGeminiError(new GeminiApiError(503, "high demand"))).toBe(true);
    expect(isRetryableGeminiError(new GeminiApiError(429, "rate limited"))).toBe(true);
    expect(isRetryableGeminiError(new TypeError("network failure"))).toBe(true);
    expect(isRetryableGeminiError(new GeminiRequestTimeoutError(60_000))).toBe(true);
    expect(isRetryableGeminiError(new GeminiApiError(404, "model unavailable"))).toBe(false);
    expect(isRetryableGeminiError(new GeminiApiError(400, "invalid schema"))).toBe(false);
    expect(isRetryableGeminiError(new SyntaxError("invalid JSON"))).toBe(false);
    expect(isRetryableGeminiError(new z.ZodError([]))).toBe(false);
    expect(isRetryableGeminiError(new Error("application failure"))).toBe(false);
  });
});
