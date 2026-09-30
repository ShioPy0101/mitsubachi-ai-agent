import { describe, expect, it } from "vitest";
import {
  GeminiApiError,
  GeminiMetadataService,
  GeminiRequestTimeoutError,
  isRetryableGeminiError,
} from "../src/metadata/gemini";
import { buildGeminiAnalysisPrompt } from "../src/metadata/analysis-prompt";
import { buildGeminiNormalizationPrompt } from "../src/metadata/prompt";
import {
  GeminiAnalysisSchema,
  GeminiNormalizationSchema,
  geminiAnalysisJsonSchema,
  geminiNormalizationJsonSchema,
} from "../src/metadata/schema";
import type { AnnouncementAnalysis } from "../src/metadata/service";

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

const geminiEnvelope = (value: unknown): Response => Response.json({
  candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }],
});

describe("two-stage Gemini metadata boundary", () => {
  it("validates the separate analysis and normalization schemas", () => {
    expect(GeminiAnalysisSchema.parse(validAnalysisOutput).departureTime).toBe("13:25");
    expect(() => GeminiAnalysisSchema.parse({ ...validAnalysisOutput, departureTime: "1:25" })).toThrow();
    expect(() => GeminiAnalysisSchema.parse({ ...validAnalysisOutput, station: "架空駅" })).toThrow();
    expect(() => GeminiNormalizationSchema.parse({ normalizedTranscription: "  " })).toThrow();
    expect(geminiAnalysisJsonSchema.properties.mentions.type).toBe("array");
    expect(geminiNormalizationJsonSchema.properties.normalizedTranscription.minLength).toBe(1);
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
    const fetcher = async (): Promise<Response> => geminiEnvelope({ normalizedTranscription: "" });
    const result = await new GeminiMetadataService("secret", "gemini-test", fetcher)
      .normalize("補正前の駅放送", analysis, []);
    expect(result.normalizedTranscription).toBe("補正前の駅放送");
  });

  it("rejects a wholesale plausible-sounding rewrite of a damaged transcription", async () => {
    const transcription = "2番線に電車か参ります黄色い線までお下かりください名鉄名古屋神宮方面の普通名鉄一宮行き神話口福岐千田竹豊上青山奈良は千田半田の順に止まり千田半田から快速急行に変わり集落園にも止まります";
    const overcorrected = "まもなく2番線に電車が参ります。黄色い線までお下がりください。名鉄名古屋、神宮前方面の普通、名鉄一宮行きです。神宮前、堀田、伝馬、大江、大同町、柴田、聚楽園の順に止まります。聚楽園から快速急行に変わり、太田川にも止まります。";
    const fetcher = async (): Promise<Response> => geminiEnvelope({ normalizedTranscription: overcorrected });
    const result = await new GeminiMetadataService("secret", "gemini-test", fetcher)
      .normalize(transcription, analysis, []);

    expect(result.normalizedTranscription).toBe(transcription);
    expect(result.normalizationGuard).toMatchObject({ accepted: false, reason: "excessive_rewrite" });
    expect(result.normalizationGuard.similarity).toBeLessThan(0.72);
    expect(result.diagnostics.responseText).toContain(overcorrected);
  });

  it("accepts a localized correction in a long announcement", async () => {
    const transcription = `まもなく列車が到着します。${"案内をよくお聞きください。".repeat(5)}黄色い展示ブロックまでお下がりください。`;
    const corrected = transcription.replace("黄色い展示ブロック", "黄色い点字ブロック");
    const fetcher = async (): Promise<Response> => geminiEnvelope({ normalizedTranscription: corrected });
    const result = await new GeminiMetadataService("secret", "gemini-test", fetcher)
      .normalize(transcription, analysis, []);

    expect(result.normalizedTranscription).toBe(corrected);
    expect(result.normalizationGuard.reason).toBe("accepted");
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
  });
});
