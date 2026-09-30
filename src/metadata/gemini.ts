import {
  GeminiAnalysisSchema,
  GeminiNormalizationSchema,
  GeminiResponseSchema,
  geminiAnalysisJsonSchema,
  geminiNormalizationJsonSchema,
} from "./schema";
import { buildGeminiAnalysisPrompt } from "./analysis-prompt";
import { buildGeminiNormalizationPrompt, type StopSequenceContext } from "./prompt";
import type { AnnouncementAnalysis, StationMention } from "./service";
import { levenshteinDistance, stringSimilarity } from "../stations/similarity";

export class GeminiSafetyBlockedError extends Error {
  constructor(readonly blockedCategories: readonly string[]) {
    super("Gemini blocked the transcription due to safety settings");
    this.name = "GeminiSafetyBlockedError";
  }
}

export class GeminiApiError extends Error {
  constructor(readonly status: number, readonly responseBody: string) {
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

export type GeminiCallDiagnostics = {
  prompt: string;
  request: unknown;
  response: unknown;
  responseText: string;
};

export type NormalizationGuard = {
  accepted: boolean;
  similarity: number;
  editDistance: number;
  reason: "accepted" | "excessive_rewrite";
};

export type GeminiDiagnostics = {
  analysis: GeminiCallDiagnostics;
  normalization: GeminiCallDiagnostics;
  normalizationGuard: NormalizationGuard;
};

export type GeminiAnalysisExtraction = AnnouncementAnalysis & { diagnostics: GeminiCallDiagnostics };
export type GeminiNormalizationExtraction = {
  normalizedTranscription: string;
  diagnostics: GeminiCallDiagnostics;
  normalizationGuard: NormalizationGuard;
};

const defaultFetcher: HttpFetcher = (input, init) => fetch(input, init);

function comparisonText(value: string): string {
  return value.normalize("NFKC").replace(/[\s、。,.!?！？「」『』（）()：:;；]/gu, "");
}

function checkNormalization(transcription: string, normalized: string): NormalizationGuard {
  const raw = comparisonText(transcription);
  const corrected = comparisonText(normalized);
  const similarity = stringSimilarity(raw, corrected);
  const editDistance = levenshteinDistance(raw, corrected);
  const looksLikeDeduplication = corrected.length > 0 && raw.includes(corrected);
  const excessiveRewrite = raw.length >= 50
    && !looksLikeDeduplication
    && similarity < 0.72
    && editDistance >= 20;
  return {
    accepted: !excessiveRewrite,
    similarity,
    editDistance,
    reason: excessiveRewrite ? "excessive_rewrite" : "accepted",
  };
}

function sanitizeMentions(transcription: string, mentions: readonly StationMention[]): StationMention[] {
  let cursor = 0;
  const sanitized: StationMention[] = [];
  for (const mention of mentions) {
    let start = transcription.indexOf(mention.text, cursor);
    if (start < 0) start = transcription.indexOf(mention.text);
    if (start < 0) continue;
    const end = start + mention.text.length;
    sanitized.push({ ...mention, start, end });
    cursor = end;
  }
  return sanitized.sort((left, right) => (left.start ?? 0) - (right.start ?? 0));
}

type GeneratedJson = { parsedJson: unknown; diagnostics: GeminiCallDiagnostics };

export class GeminiMetadataService {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetcher: HttpFetcher = defaultFetcher,
    private readonly timeoutMs = defaultGeminiTimeoutMs,
  ) {}

  private async generate(prompt: string, responseJsonSchema: unknown): Promise<GeneratedJson> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const requestBody = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseJsonSchema },
      safetySettings: [
        "HARM_CATEGORY_HARASSMENT",
        "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        "HARM_CATEGORY_DANGEROUS_CONTENT",
      ].map((category) => ({ category, threshold: "BLOCK_LOW_AND_ABOVE" })),
    };
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
        this.fetcher(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
          signal: controller.signal,
          body: JSON.stringify(requestBody),
        }),
        timeout,
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    if (!response.ok) throw new GeminiApiError(response.status, (await response.text()).slice(0, 500));
    const rawResponse: unknown = await response.json();
    const envelope = GeminiResponseSchema.parse(rawResponse);
    const promptBlockedCategories = envelope.promptFeedback?.safetyRatings
      ?.filter((rating) => rating.blocked).map((rating) => rating.category) ?? [];
    if (envelope.promptFeedback?.blockReason !== undefined) {
      throw new GeminiSafetyBlockedError(
        promptBlockedCategories.length > 0 ? promptBlockedCategories : [envelope.promptFeedback.blockReason],
      );
    }
    const candidate = envelope.candidates[0];
    const responseBlockedCategories = candidate?.safetyRatings
      ?.filter((rating) => rating.blocked).map((rating) => rating.category) ?? [];
    const blockedFinishReasons = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION"]);
    if (responseBlockedCategories.length > 0
      || (candidate?.finishReason !== undefined && blockedFinishReasons.has(candidate.finishReason))) {
      throw new GeminiSafetyBlockedError(
        responseBlockedCategories.length > 0 ? responseBlockedCategories : [candidate?.finishReason ?? "SAFETY"],
      );
    }
    const responseText = candidate?.content?.parts?.[0]?.text;
    if (responseText === undefined) throw new Error("Gemini response did not contain JSON text");
    return {
      parsedJson: JSON.parse(responseText) as unknown,
      diagnostics: {
        prompt,
        request: {
          method: "POST",
          endpoint,
          headers: { "Content-Type": "application/json", "x-goog-api-key": "[REDACTED]" },
          body: requestBody,
        },
        response: rawResponse,
        responseText,
      },
    };
  }

  async analyze(transcription: string): Promise<GeminiAnalysisExtraction> {
    const generated = await this.generate(buildGeminiAnalysisPrompt(transcription), geminiAnalysisJsonSchema);
    const parsed = GeminiAnalysisSchema.parse(generated.parsedJson);
    return {
      isTransitAnnouncement: parsed.isTransitAnnouncement,
      mentions: sanitizeMentions(transcription, parsed.mentions),
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
  ): Promise<GeminiNormalizationExtraction> {
    const generated = await this.generate(
      buildGeminiNormalizationPrompt(transcription, analysis, sequences),
      geminiNormalizationJsonSchema,
    );
    const raw = generated.parsedJson;
    const normalizedJson = typeof raw === "object" && raw !== null
      && "normalizedTranscription" in raw && raw.normalizedTranscription === ""
      ? { ...raw, normalizedTranscription: transcription }
      : raw;
    const parsed = GeminiNormalizationSchema.parse(normalizedJson);
    const normalizationGuard = checkNormalization(transcription, parsed.normalizedTranscription);
    return {
      normalizedTranscription: normalizationGuard.accepted ? parsed.normalizedTranscription : transcription,
      diagnostics: generated.diagnostics,
      normalizationGuard,
    };
  }
}
