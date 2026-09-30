import { GeminiResponseSchema, TransitAnnouncementSchema, transitAnnouncementJsonSchema } from "./schema";
import { buildGeminiPrompt } from "./prompt";
import type { MetadataResult, MetadataService } from "./service";
import type { StationCandidate } from "../stations/types";

export class GeminiSafetyBlockedError extends Error {
  constructor(readonly blockedCategories: readonly string[]) {
    super("Gemini blocked the transcription due to safety settings");
    this.name = "GeminiSafetyBlockedError";
  }
}

export class GeminiApiError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`Gemini request failed with HTTP ${status}: ${responseBody}`);
    this.name = "GeminiApiError";
  }
}

const defaultGeminiTimeoutMs = 60_000;

export class GeminiRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Gemini request timed out after ${timeoutMs}ms`);
    this.name = "GeminiRequestTimeoutError";
  }
}

export function isRetryableGeminiError(error: unknown): boolean {
  return !(error instanceof GeminiApiError) || error.status === 429 || error.status >= 500;
}

export type HttpFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const defaultFetcher: HttpFetcher = (input, init) => fetch(input, init);

export class GeminiMetadataService implements MetadataService {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetcher: HttpFetcher = defaultFetcher,
    private readonly timeoutMs = defaultGeminiTimeoutMs,
  ) {}

  async extract(transcription: string, stationCandidates: readonly StationCandidate[]): Promise<MetadataResult> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new GeminiRequestTimeoutError(this.timeoutMs));
      }, this.timeoutMs);
    });
    let response: Response;
    try {
      response = await Promise.race([
        this.fetcher(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: buildGeminiPrompt(transcription, stationCandidates) }] }],
              generationConfig: {
                temperature: 0,
                responseMimeType: "application/json",
                responseJsonSchema: transitAnnouncementJsonSchema,
              },
              safetySettings: [
                "HARM_CATEGORY_HARASSMENT",
                "HARM_CATEGORY_HATE_SPEECH",
                "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "HARM_CATEGORY_DANGEROUS_CONTENT",
              ].map((category) => ({ category, threshold: "BLOCK_LOW_AND_ABOVE" })),
            }),
          },
        ),
        timeout,
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    if (!response.ok) {
      throw new GeminiApiError(response.status, (await response.text()).slice(0, 500));
    }
    const envelope = GeminiResponseSchema.parse(await response.json());
    const promptBlockedCategories = envelope.promptFeedback?.safetyRatings
      ?.filter((rating) => rating.blocked)
      .map((rating) => rating.category) ?? [];
    if (envelope.promptFeedback?.blockReason !== undefined) {
      throw new GeminiSafetyBlockedError(
        promptBlockedCategories.length > 0 ? promptBlockedCategories : [envelope.promptFeedback.blockReason],
      );
    }
    const candidate = envelope.candidates[0];
    const responseBlockedCategories = candidate?.safetyRatings
      ?.filter((rating) => rating.blocked)
      .map((rating) => rating.category) ?? [];
    const blockedFinishReasons = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION"]);
    if (responseBlockedCategories.length > 0
      || (candidate?.finishReason !== undefined && blockedFinishReasons.has(candidate.finishReason))) {
      throw new GeminiSafetyBlockedError(
        responseBlockedCategories.length > 0
          ? responseBlockedCategories
          : [candidate?.finishReason ?? "SAFETY"],
      );
    }
    const text = candidate?.content?.parts[0]?.text;
    if (text === undefined) throw new Error("Gemini response did not contain JSON text");
    const parsedJson: unknown = JSON.parse(text);
    const normalizedJson = typeof parsedJson === "object"
      && parsedJson !== null
      && "normalizedTranscription" in parsedJson
      && typeof parsedJson.normalizedTranscription === "string"
      && parsedJson.normalizedTranscription.trim() === ""
      && transcription.trim() !== ""
      ? { ...parsedJson, normalizedTranscription: transcription }
      : parsedJson;
    const parsed = TransitAnnouncementSchema.parse(normalizedJson);
    return {
      isTransitAnnouncement: parsed.isTransitAnnouncement,
      normalizedTranscription: parsed.normalizedTranscription,
      metadata: {
        station: null,
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
