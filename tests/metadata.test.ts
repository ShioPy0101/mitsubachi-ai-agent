import { describe, expect, it } from "vitest";
import { GeminiApiError, GeminiMetadataService, isRetryableGeminiError } from "../src/metadata/gemini";
import { buildGeminiPrompt } from "../src/metadata/prompt";
import { RailwayAnnouncementSchema } from "../src/metadata/schema";
import { scoreStation } from "../src/stations/candidate-service";
import { iseStations } from "./fixtures/stations";

const validOutput = {
  normalizedTranscription: "次は五十鈴ヶ丘です",
  station: "五十鈴ヶ丘",
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
    expect(RailwayAnnouncementSchema.parse(validOutput).departureTime).toBe("13:25");
    expect(() => RailwayAnnouncementSchema.parse({ ...validOutput, departureTime: "1:25" })).toThrow();
    expect(() => RailwayAnnouncementSchema.parse({ ...validOutput, category: "invented" })).toThrow();
    expect(() => RailwayAnnouncementSchema.parse({ ...validOutput, summary: "長".repeat(31) })).toThrow();
  });

  it("includes non-inference and station candidate rules in the prompt", () => {
    const station = iseStations[1];
    expect(station).toBeDefined();
    if (station === undefined) return;
    const prompt = buildGeminiPrompt("次はいすずがおかです", [scoreStation(station, "いすずがおか", {})]);
    expect(prompt).toContain("知識による補完は禁止");
    expect(prompt).toContain("駅名を自由生成しないでください");
    expect(prompt).toContain('"name":"五十鈴ヶ丘"');
    expect(prompt).toContain("departureTime / arrivalTime は HH:MM");
  });

  it("drops a station returned outside the supplied candidates", async () => {
    const station = iseStations[1];
    expect(station).toBeDefined();
    if (station === undefined) return;
    const fetcher = async (): Promise<Response> => Response.json({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ ...validOutput, station: "架空駅" }) }] } }],
    });
    const service = new GeminiMetadataService("secret", "gemini-test", fetcher);
    const result = await service.extract("次はいすずがおかです", [scoreStation(station, "いすずがおか", {})]);
    expect(result.metadata.station).toBeNull();
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

  it("retries temporary Gemini failures but not deterministic client errors", () => {
    expect(isRetryableGeminiError(new GeminiApiError(503, "high demand"))).toBe(true);
    expect(isRetryableGeminiError(new GeminiApiError(429, "rate limited"))).toBe(true);
    expect(isRetryableGeminiError(new TypeError("network failure"))).toBe(true);
    expect(isRetryableGeminiError(new GeminiApiError(404, "model unavailable"))).toBe(false);
    expect(isRetryableGeminiError(new GeminiApiError(400, "invalid schema"))).toBe(false);
  });
});
