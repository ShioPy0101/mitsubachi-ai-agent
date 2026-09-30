import { describe, expect, it } from "vitest";
import { GeminiApiError, GeminiMetadataService, isRetryableGeminiError } from "../src/metadata/gemini";
import { buildGeminiPrompt } from "../src/metadata/prompt";
import { TransitAnnouncementSchema, transitAnnouncementJsonSchema } from "../src/metadata/schema";
import { scoreStation } from "../src/stations/candidate-service";
import { iseStations } from "./fixtures/stations";

const validOutput = {
  isTransitAnnouncement: true,
  normalizedTranscription: "次は五十鈴ヶ丘です",
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
  summary: "次は五十鈴ヶ丘",
};

describe("Gemini metadata boundary", () => {
  it("validates the structured schema", () => {
    expect(TransitAnnouncementSchema.parse(validOutput).departureTime).toBe("13:25");
    expect(() => TransitAnnouncementSchema.parse({ ...validOutput, departureTime: "1:25" })).toThrow();
    expect(() => TransitAnnouncementSchema.parse({ ...validOutput, category: "invented" })).toThrow();
    expect(() => TransitAnnouncementSchema.parse({ ...validOutput, summary: "長".repeat(31) })).toThrow();
    expect(() => TransitAnnouncementSchema.parse({ ...validOutput, normalizedTranscription: "  " })).toThrow();
    expect(transitAnnouncementJsonSchema.properties.normalizedTranscription.minLength).toBe(1);
  });

  it("includes non-inference and station candidate rules in the prompt", () => {
    const station = iseStations[1];
    expect(station).toBeDefined();
    if (station === undefined) return;
    const prompt = buildGeminiPrompt("次はいすずがおかです", [scoreStation(station, "いすずがおか", {})]);
    expect(prompt).toContain("知識による補完は禁止");
    expect(prompt).toContain("文字起こし補正専用の候補");
    expect(prompt).toContain('"stationName":"五十鈴ヶ丘"');
    expect(prompt).toContain("departureTime / arrivalTime は HH:MM");
    expect(prompt).toContain("「鶴ヶ方面」→「敦賀方面」");
    expect(prompt).toContain("梅田・なんば・天王寺方面、なかもず行");
    expect(prompt).toContain("黄色い点字ブロック");
    expect(prompt).toContain("同じ言語の同一文または案内ブロック");
    expect(prompt).toContain("時刻・番線・行先などが異なる繰り返しは削除しない");
    expect(prompt).toContain("各言語を元の言語のまま保持");
    expect(prompt).toContain("異なる言語による同内容の案内は重複とみなさない");
    expect(prompt).toContain("必ず空文字にせず");
    expect(prompt).toContain("迷う場合はfalse");
    expect(prompt).toContain("路線バス");
    expect(prompt).toContain("isTransitAnnouncement");
    expect(prompt).toContain("routeSupported");
    expect(prompt).toContain("routeCandidateIds");
    expect(prompt).toContain("経路上にあるという理由だけでnormalizedTranscriptionへ駅名を追加してはいけません");
    expect(prompt).toContain("福井、芦原温泉、加賀温泉");
    expect(prompt).toContain("収録駅は音声から推定しません");
    expect(prompt).toContain("stationは常にnull");
  });

  it("rejects a recording station because station must stay null", () => {
    expect(() => TransitAnnouncementSchema.parse({ ...validOutput, station: "架空駅" })).toThrow();
  });

  it("falls back to a non-empty raw transcription when Gemini returns an empty normalized value", async () => {
    const fetcher = async (): Promise<Response> => Response.json({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ ...validOutput, normalizedTranscription: "" }) }] } }],
    });
    const service = new GeminiMetadataService("secret", "gemini-test", fetcher);

    const result = await service.extract("補正前の駅放送", []);

    expect(result.normalizedTranscription).toBe("補正前の駅放送");
  });

  it("preserves Gemini HTTP error details for consumer logs", async () => {
    const fetcher = async (): Promise<Response> => new Response(
      '{"error":{"message":"API key not valid"}}',
      { status: 400 },
    );
    const service = new GeminiMetadataService("invalid", "gemini-test", fetcher);

    await expect(service.extract("test", [])).rejects.toEqual(new GeminiApiError(
      400,
      '{"error":{"message":"API key not valid"}}',
    ));
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

    await expect(service.extract("unsafe", [])).rejects.toMatchObject({
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
    const service = new GeminiMetadataService("secret", "gemini-test", fetcher);

    await expect(service.extract("unsafe", [])).rejects.toMatchObject({
      name: "GeminiSafetyBlockedError",
      blockedCategories: ["HARM_CATEGORY_SEXUALLY_EXPLICIT"],
    });
  });

  it("retries temporary Gemini failures but not deterministic client errors", () => {
    expect(isRetryableGeminiError(new GeminiApiError(503, "high demand"))).toBe(true);
    expect(isRetryableGeminiError(new GeminiApiError(429, "rate limited"))).toBe(true);
    expect(isRetryableGeminiError(new TypeError("network failure"))).toBe(true);
    expect(isRetryableGeminiError(new GeminiApiError(404, "model unavailable"))).toBe(false);
    expect(isRetryableGeminiError(new GeminiApiError(400, "invalid schema"))).toBe(false);
  });
});
