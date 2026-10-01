import { observeNormalization, type NormalizationObservation } from "./normalization-observation";
import { announcementLanguage, buildSemanticRepresentation, type NormalizedAnnouncementEvent } from "../railway/semantic";
import type { z } from "zod";
import { buildGeminiAnalysisPrompt } from "./analysis-prompt";
import { buildGeminiNormalizationPrompt, type StopSequenceContext } from "./prompt";
import { GeminiAnalysisSchema, GeminiNormalizationSchema, GeminiResponseSchema, geminiAnalysisJsonSchema, geminiNormalizationJsonSchema } from "./schema";
import type { AnnouncementAnalysis, StationMention } from "./service";

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
  if (error instanceof GeminiApiError) return error.status === 429 || error.status >= 500;
  return error instanceof GeminiRequestTimeoutError || error instanceof TypeError;
}

export type HttpFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type GeminiCallDiagnostics = {
  prompt: string;
  request: unknown;
  response: unknown;
  responseText: string;
};

export type GeminiDiagnostics = {
  analysis: GeminiCallDiagnostics;
  normalization: GeminiCallDiagnostics;
  normalizationObservation: NormalizationObservation;
};
export type GeminiAnalysisExtraction = AnnouncementAnalysis & {
  diagnostics: GeminiCallDiagnostics;
};
export type GeminiNormalizationExtraction = {
  normalizedTranscription: string;
  entities: NormalizedEntity[];
  normalizedEvents?: NormalizedAnnouncementEvent[];
  diagnostics: GeminiCallDiagnostics;
  normalizationObservation: NormalizationObservation;
};
const defaultFetcher: HttpFetcher = (input, init) => fetch(input, init);
export type NormalizedEntity = z.output<typeof GeminiNormalizationSchema>["entities"][number];
function sanitizeMentions(
  transcription: string,
  mentions: readonly StationMention[],
  events: readonly import("../railway/semantic").SemanticEventProposal[] = [],
): StationMention[] {
  const sanitized: StationMention[] = [];

  for (const mention of mentions) {
    let start: number | null = null;

    if (mention.start != null && mention.end != null && transcription.slice(mention.start, mention.end) === mention.text) {
      start = mention.start;
    } else {
      const found = transcription.indexOf(mention.text);
      if (found >= 0) start = found;
    }

    if (start == null) continue;

    const end = start + mention.text.length;

    sanitized.push({
      ...mention,
      id: `mention:${start}:${end}`,
      language: mention.language ?? events.find((e) => e.sourceStart <= start && e.sourceEnd >= end)?.language ?? announcementLanguage(mention.text),
      equivalentEventGroupId:
        mention.equivalentEventGroupId ?? events.find((e) => e.sourceStart <= start && e.sourceEnd >= end)?.equivalentEventGroupId ?? null,
      start,
      end,
    });
  }

  return sanitized.sort((left, right) => (left.start ?? 0) - (right.start ?? 0));
}

type GeneratedJson = {
  responseText: string;
  diagnostics: GeminiCallDiagnostics;
};

export class GeminiMetadataService {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetcher: HttpFetcher = defaultFetcher,
    private readonly timeoutMs = defaultGeminiTimeoutMs,
  ) {}

  private async generate(prompt: string, responseJsonSchema: unknown, signal?: AbortSignal): Promise<GeneratedJson> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const requestBody = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema,
      },
      safetySettings: ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"].map(
        (category) => ({ category, threshold: "BLOCK_LOW_AND_ABOVE" }),
      ),
    };
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new GeminiRequestTimeoutError(this.timeoutMs));
      }, this.timeoutMs);
    });
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let rawResponse: unknown;
    try {
      rawResponse = await Promise.race([
        (async () => {
          const response = await this.fetcher(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": this.apiKey,
            },
            signal: controller.signal,
            body: JSON.stringify(requestBody),
          });
          if (!response.ok) throw new GeminiApiError(response.status, (await response.text()).slice(0, 500));
          return response.json() as Promise<unknown>;
        })(),
        timeout,
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abort);
    }
    const envelope = GeminiResponseSchema.parse(rawResponse);
    const promptBlockedCategories = envelope.promptFeedback?.safetyRatings?.filter((rating) => rating.blocked).map((rating) => rating.category) ?? [];
    if (envelope.promptFeedback?.blockReason !== undefined) {
      throw new GeminiSafetyBlockedError(promptBlockedCategories.length > 0 ? promptBlockedCategories : [envelope.promptFeedback.blockReason]);
    }
    const candidate = envelope.candidates[0];
    const responseBlockedCategories = candidate?.safetyRatings?.filter((rating) => rating.blocked).map((rating) => rating.category) ?? [];
    const blockedFinishReasons = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION"]);
    if (responseBlockedCategories.length > 0 || (candidate?.finishReason !== undefined && blockedFinishReasons.has(candidate.finishReason))) {
      throw new GeminiSafetyBlockedError(responseBlockedCategories.length > 0 ? responseBlockedCategories : [candidate?.finishReason ?? "SAFETY"]);
    }
    const responseText = candidate?.content?.parts?.[0]?.text;
    if (responseText === undefined) throw new Error("Gemini response did not contain JSON text");
    return {
      responseText,
      diagnostics: {
        prompt,
        request: {
          method: "POST",
          endpoint,
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": "[REDACTED]",
          },
          body: requestBody,
        },
        response: rawResponse,
        responseText,
      },
    };
  }

  async analyze(transcription: string, signal?: AbortSignal): Promise<GeminiAnalysisExtraction> {
    const generated = await this.generate(buildGeminiAnalysisPrompt(transcription), geminiAnalysisJsonSchema, signal);
    const parsed = GeminiAnalysisSchema.parse(JSON.parse(generated.responseText) as unknown);
    return {
      isTransitAnnouncement: parsed.isTransitAnnouncement,
      mentions: sanitizeMentions(transcription, parsed.mentions, parsed.events),
      semantic: buildSemanticRepresentation(transcription, sanitizeMentions(transcription, parsed.mentions, parsed.events), parsed.events),
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
      diagnostics: generated.diagnostics,
    };
  }

  async normalize(
    transcription: string,
    analysis: AnnouncementAnalysis,
    sequences: readonly StopSequenceContext[],
    signal?: AbortSignal,
  ): Promise<GeminiNormalizationExtraction> {
    const generated = await this.generate(buildGeminiNormalizationPrompt(transcription, analysis, sequences), geminiNormalizationJsonSchema, signal);
    let raw: unknown;
    try {
      raw = JSON.parse(generated.responseText);
    } catch {
      raw = null;
    }
    const parsed = GeminiNormalizationSchema.safeParse(raw);
    if (!parsed.success) {
      const empty = typeof raw === "object" && raw !== null && "normalizedTranscription" in raw && raw.normalizedTranscription === "";
      return {
        normalizedTranscription: transcription,
        entities: [],
        diagnostics: generated.diagnostics,
        normalizationObservation: {
          ...observeNormalization(transcription, transcription, analysis, sequences),
          outcome: empty ? "empty_output" : "invalid_output",
        },
      };
    }
    const output = parsed.data;
    const observation = observeNormalization(transcription, output.normalizedTranscription, analysis, sequences, output.entities, output.normalizedEvents);
    // Events are annotations for diagnostics, never an alternative document.
    // Missing IDs remain observations; do not splice source slices into model prose.
    return {
      normalizedTranscription: output.normalizedTranscription,
      entities: output.entities,
      ...(output.normalizedEvents ? { normalizedEvents: output.normalizedEvents } : {}),
      diagnostics: generated.diagnostics,
      normalizationObservation: observation,
    };
  }
}
