import { GeminiResponseSchema, RailwayAnnouncementSchema, railwayAnnouncementJsonSchema } from "./schema";
import { buildGeminiPrompt } from "./prompt";
import type { MetadataResult, MetadataService } from "./service";
import type { StationCandidate } from "../stations/types";

export class GeminiApiError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`Gemini request failed with HTTP ${status}: ${responseBody}`);
    this.name = "GeminiApiError";
  }
}

export type HttpFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const defaultFetcher: HttpFetcher = (input, init) => fetch(input, init);

export class GeminiMetadataService implements MetadataService {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetcher: HttpFetcher = defaultFetcher,
  ) {}

  async extract(transcription: string, stationCandidates: readonly StationCandidate[]): Promise<MetadataResult> {
    const response = await this.fetcher(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: buildGeminiPrompt(transcription, stationCandidates) }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseJsonSchema: railwayAnnouncementJsonSchema,
          },
        }),
      },
    );
    if (!response.ok) {
      throw new GeminiApiError(response.status, (await response.text()).slice(0, 500));
    }
    const envelope = GeminiResponseSchema.parse(await response.json());
    const text = envelope.candidates[0]?.content.parts[0]?.text;
    if (text === undefined) throw new Error("Gemini response did not contain JSON text");
    const parsedJson: unknown = JSON.parse(text);
    const parsed = RailwayAnnouncementSchema.parse(parsedJson);
    const candidateNames = new Set(stationCandidates.map(({ station }) => station.name));
    return {
      normalizedTranscription: parsed.normalizedTranscription,
      metadata: {
        station: parsed.station !== null && candidateNames.has(parsed.station) ? parsed.station : null,
        line: parsed.line,
        trainType: parsed.trainType,
        trainName: parsed.trainName,
        trainNumber: parsed.trainNumber,
        destination: parsed.destination,
        departureTime: parsed.departureTime,
        arrivalTime: parsed.arrivalTime,
        platform: parsed.platform,
        nextStation: parsed.nextStation,
        category: parsed.category,
        summary: parsed.summary,
      },
    };
  }
}
