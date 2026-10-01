import {
  GeminiAnalysisSchema,
  GeminiNormalizationSchema,
  GeminiResponseSchema,
  geminiAnalysisJsonSchema,
  geminiNormalizationJsonSchema,
} from "./schema";
import type { z } from "zod";
import { buildGeminiAnalysisPrompt } from "./analysis-prompt";
import { buildGeminiNormalizationPrompt, type StopSequenceContext } from "./prompt";
import type { AnnouncementAnalysis, StationMention } from "./service";
import type { RailwayAnnouncementMetadata } from "../railway/types";
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

export type NormalizationGuard = {
  accepted: boolean;
  risk: "low" | "medium" | "high";
  warnings: Array<{
    type:
      | "unsupported_factual_addition"
      | "unsupported_entity_correction"
      | "large_non_entity_rewrite"
      | "output_format_failure";
    entities?: string[];
  }>;
  similarity: number;
  editDistance: number;
  globalSimilarity: number;
  entitySimilarity: number;
  nonEntitySimilarity: number;
  supportedEntityCorrections: number;
  unsupportedEntityCorrections: number;
  unsupportedEntities: string[];
  reason:
    | "accepted"
    | "route_supported_entity_corrections"
    | "unsupported_factual_addition"
    | "unsupported_entity_insertion"
    | "unsupported_non_entity_rewrite"
    | "catastrophic_deletion"
    | "catastrophic_expansion"
    | "unrelated_rewrite"
    | "empty_output"
    | "invalid_output";
};

export type GeminiDiagnostics = {
  analysis: GeminiCallDiagnostics;
  normalization: GeminiCallDiagnostics;
  normalizationGuard: NormalizationGuard;
};

export type GeminiAnalysisExtraction = AnnouncementAnalysis & { diagnostics: GeminiCallDiagnostics };
export type GeminiNormalizationExtraction = {
  normalizedTranscription: string;
  entities: NormalizedEntity[];
  diagnostics: GeminiCallDiagnostics;
  normalizationGuard: NormalizationGuard;
};

const defaultFetcher: HttpFetcher = (input, init) => fetch(input, init);

function comparisonText(value: string): string {
  return value.normalize("NFKC").replace(/[\s、。,.!?！？「」『』（）()：:;；]/gu, "");
}

type EntityCorrectionAssessment = {
  rawEntities: string[];
  normalizedEntities: string[];
  rawMaskEntities: string[];
  normalizedMaskEntities: string[];
  supported: number;
  unsupported: number;
};

export type NormalizedEntity = z.output<typeof GeminiNormalizationSchema>["entities"][number];

export function applyNormalizedEntitiesToMetadata(
  metadata: RailwayAnnouncementMetadata,
  entities: readonly NormalizedEntity[],
): RailwayAnnouncementMetadata {
  const corrected = { ...metadata };
  const fields = {
    destination: "destination",
    line: "line",
    train_name: "trainName",
    train_type: "trainType",
  } as const;
  for (const entity of entities) {
    const field = fields[entity.kind as keyof typeof fields];
    if (field === undefined || entity.sourceText === null) continue;
    if (corrected[field] === entity.sourceText) corrected[field] = entity.text;
  }
  return corrected;
}

function routeSupportedTargets(sequence: StopSequenceContext, mentionIndex: number): string[] {
  const fromMentionCandidates = (sequence.mentionCandidates[mentionIndex] ?? [])
    .filter((candidate) => candidate.routeHypothesisIds.length > 0
      && candidate.lexicalScore >= 0.2
      && candidate.bestRouteScore !== null)
    .map((candidate) => candidate.station.name);
  const fromRouteMatches = sequence.routeHypotheses.flatMap((route) =>
    (route.mentionMatches ?? [])
      .filter((match) => match.mentionIndex === mentionIndex && match.lexicalSimilarity >= 0.2)
      .map((match) => match.station.name));
  return [...new Set([...fromMentionCandidates, ...fromRouteMatches])];
}

function assessEntityCorrections(
  normalized: string,
  analysis: AnnouncementAnalysis,
  sequences: readonly StopSequenceContext[],
): EntityCorrectionAssessment {
  const targetsByMention = new Map<string, Set<string>>();
  for (const sequence of sequences) {
    const searchMentions = [...sequence.mentions, ...sequence.contextMentions];
    searchMentions.forEach((mention, mentionIndex) => {
      const targets = targetsByMention.get(mention.text) ?? new Set<string>();
      for (const target of routeSupportedTargets(sequence, mentionIndex)) targets.add(target);
      targetsByMention.set(mention.text, targets);
    });
  }
  const rawEntities: string[] = [];
  const normalizedEntities: string[] = [];
  const rawMaskEntities: string[] = [];
  const normalizedMaskEntities: string[] = [];
  let supported = 0;
  let unsupported = 0;
  for (const mention of analysis.mentions) {
    rawEntities.push(mention.text);
    rawMaskEntities.push(mention.text);
    if (normalized.includes(mention.text)) {
      normalizedEntities.push(mention.text);
      normalizedMaskEntities.push(mention.text);
      continue;
    }
    const supportedTarget = [...(targetsByMention.get(mention.text) ?? [])]
      .sort((left, right) => right.length - left.length)
      .find((target) => normalized.includes(target));
    if (supportedTarget !== undefined) {
      supported += 1;
      normalizedEntities.push(supportedTarget);
      normalizedMaskEntities.push(supportedTarget);
    } else {
      unsupported += 1;
    }
  }
  for (const value of Object.values(analysis.metadata)) {
    if (typeof value !== "string" || value === "" || !normalized.includes(value)) continue;
    rawMaskEntities.push(value);
    normalizedMaskEntities.push(value);
  }
  return { rawEntities, normalizedEntities, rawMaskEntities, normalizedMaskEntities, supported, unsupported };
}

function maskEntities(value: string, entities: readonly string[]): string {
  let masked = value;
  for (const entity of [...new Set(entities)].sort((left, right) => right.length - left.length)) {
    masked = masked.replaceAll(entity, "固有名詞");
  }
  return masked.replace(
    /((?:特急|快速急行|快速|急行|普通)[、\s]*)([^、。\s]{1,20}?)(\d+号)/gu,
    "$1列車名$3",
  );
}

function factualTokens(value: string): Set<string> {
  const normalized = value.normalize("NFKC");
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/\b\d{1,2}:\d{2}\b|\d{1,2}時\d{1,2}分/gu)) tokens.add(`time:${match[0]}`);
  for (const match of normalized.matchAll(/\d+番(?:線|乗り場)/gu)) tokens.add(`platform:${match[0]}`);
  if (/乗り換え|乗換/gu.test(normalized)) tokens.add("transfer");
  return tokens;
}

type SupportedEntityNames = {
  stations: Set<string>;
  lines: Set<string>;
  trainNames: Set<string>;
  trainTypes: Set<string>;
  other: Set<string>;
};

function supportedEntityNames(
  analysis: AnnouncementAnalysis,
  sequences: readonly StopSequenceContext[],
): SupportedEntityNames {
  const stations = new Set(analysis.mentions.map((mention) => mention.text));
  const lines = new Set<string>();
  const trainNames = new Set<string>();
  const trainTypes = new Set<string>();
  const other = new Set<string>();
  if (analysis.metadata.station !== null) stations.add(analysis.metadata.station);
  if (analysis.metadata.destination !== null) stations.add(analysis.metadata.destination);
  if (analysis.metadata.nextStation !== null) stations.add(analysis.metadata.nextStation);
  if (analysis.metadata.line !== null) lines.add(analysis.metadata.line);
  if (analysis.metadata.trainName !== null) trainNames.add(analysis.metadata.trainName);
  if (analysis.metadata.trainType !== null) trainTypes.add(analysis.metadata.trainType);
  for (const sequence of sequences) {
    for (const candidate of sequence.stationCandidates) {
      stations.add(candidate.station.name);
      if (candidate.station.lineName !== null) lines.add(candidate.station.lineName);
    }
    for (const candidates of sequence.mentionCandidates) {
      for (const candidate of candidates) {
        stations.add(candidate.station.name);
        if (candidate.station.lineName !== null) lines.add(candidate.station.lineName);
      }
    }
    for (const route of sequence.routeHypotheses) {
      for (const { station } of route.stations) {
        stations.add(station.name);
        if (station.lineName !== null) lines.add(station.lineName);
      }
    }
  }
  return { stations, lines, trainNames, trainTypes, other };
}

function unsupportedNormalizedEntities(
  transcription: string,
  normalized: string,
  normalizedEntities: readonly NormalizedEntity[],
  analysis: AnnouncementAnalysis,
  sequences: readonly StopSequenceContext[],
): string[] {
  const supportedNames = supportedEntityNames(analysis, sequences);
  const unsupported: string[] = [];
  for (const entity of normalizedEntities) {
    if (!normalized.includes(entity.text)) {
      unsupported.push(entity.text);
      continue;
    }
    if (transcription.includes(entity.text)) continue;
    const structurallySupported = entity.kind === "station" || entity.kind === "destination"
      ? supportedNames.stations.has(entity.text)
      : entity.kind === "line"
        ? supportedNames.lines.has(entity.text)
        : entity.kind === "train_name"
          ? supportedNames.trainNames.has(entity.text)
          : entity.kind === "train_type"
            ? supportedNames.trainTypes.has(entity.text)
            : supportedNames.other.has(entity.text);
    if (structurallySupported) continue;
    if (entity.kind === "station" || entity.kind === "destination") {
      unsupported.push(entity.text);
      continue;
    }
    if (entity.sourceText !== null && transcription.includes(entity.sourceText)) {
      const source = comparisonText(entity.sourceText);
      const target = comparisonText(entity.text);
      if (source !== "" && target !== "" && stringSimilarity(source, target) >= 0.25) continue;
    }
    unsupported.push(entity.text);
  }
  return [...new Set(unsupported)];
}

function hasUnsupportedFactualAddition(raw: string, corrected: string): boolean {
  const rawFacts = factualTokens(raw);
  return [...factualTokens(corrected)].some((fact) => !rawFacts.has(fact));
}

export function checkNormalization(
  transcription: string,
  normalized: string,
  analysis: AnnouncementAnalysis,
  sequences: readonly StopSequenceContext[],
  normalizedEntities: readonly NormalizedEntity[] = [],
): NormalizationGuard {
  const raw = comparisonText(transcription);
  const corrected = comparisonText(normalized);
  const globalSimilarity = stringSimilarity(raw, corrected);
  const editDistance = levenshteinDistance(raw, corrected);
  const looksLikeDeduplication = corrected.length > 0 && raw.includes(corrected);
  const globallyLargeRewrite = raw.length >= 50
    && !looksLikeDeduplication
    && globalSimilarity < 0.72
    && editDistance >= 20;
  const entities = assessEntityCorrections(normalized, analysis, sequences);
  const rawNonEntity = comparisonText(maskEntities(transcription, entities.rawMaskEntities));
  const normalizedNonEntity = comparisonText(maskEntities(normalized, entities.normalizedMaskEntities));
  const nonEntitySimilarity = stringSimilarity(rawNonEntity, normalizedNonEntity);
  const entitySimilarity = entities.rawEntities.length === 0
    ? 1
    : stringSimilarity(entities.rawEntities.join("|"), entities.normalizedEntities.join("|"));
  const unsupportedAllowance = Math.max(1, Math.floor(entities.supported * 0.2));
  const routeExplainsRewrite = entities.supported >= 2
    && entities.unsupported <= unsupportedAllowance
    && nonEntitySimilarity >= 0.78;
  const unsupportedEntities = unsupportedNormalizedEntities(
    transcription,
    normalized,
    normalizedEntities,
    analysis,
    sequences,
  );
  const unsupportedFactualAddition = hasUnsupportedFactualAddition(transcription, normalized);
  const unsupportedEntityInsertion = unsupportedEntities.length > 0;
  const catastrophicDeletion = raw.length >= 30
    && corrected.length < raw.length * 0.35;
  const catastrophicExpansion = raw.length >= 20
    && corrected.length > Math.max(raw.length * 2, raw.length + 100);
  const unrelatedRewrite = raw.length >= 30
    && corrected.length >= 30
    && globalSimilarity < 0.25
    && nonEntitySimilarity < 0.25;
  // Unsupported operational facts (time/platform/transfer) can change the meaning of
  // an announcement. Entity uncertainty and ordinary rewrite volume are diagnostics;
  // they must not discard an otherwise useful full-transcription correction.
  const accepted = !unsupportedFactualAddition
    && !catastrophicDeletion
    && !catastrophicExpansion
    && !unrelatedRewrite;
  const reason: NormalizationGuard["reason"] = catastrophicDeletion
    ? "catastrophic_deletion"
    : catastrophicExpansion
      ? "catastrophic_expansion"
      : unrelatedRewrite
        ? "unrelated_rewrite"
        : unsupportedFactualAddition
          ? "unsupported_factual_addition"
          : unsupportedEntityInsertion
            ? "unsupported_entity_insertion"
            : !globallyLargeRewrite
              ? "accepted"
              : routeExplainsRewrite
                ? "route_supported_entity_corrections"
                : "unsupported_non_entity_rewrite";
  const warnings: NormalizationGuard["warnings"] = [];
  if (unsupportedFactualAddition) warnings.push({ type: "unsupported_factual_addition" });
  if (unsupportedEntityInsertion) {
    warnings.push({ type: "unsupported_entity_correction", entities: unsupportedEntities });
  }
  if (globallyLargeRewrite && !routeExplainsRewrite) warnings.push({ type: "large_non_entity_rewrite" });
  const risk: NormalizationGuard["risk"] = accepted
    ? warnings.length === 0 ? "low" : "medium"
    : "high";
  return {
    accepted,
    risk,
    warnings,
    similarity: globalSimilarity,
    editDistance,
    globalSimilarity,
    entitySimilarity,
    nonEntitySimilarity,
    supportedEntityCorrections: entities.supported,
    unsupportedEntityCorrections: entities.unsupported,
    unsupportedEntities,
    reason,
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

type GeneratedJson = { responseText: string; diagnostics: GeminiCallDiagnostics };

function failedNormalizationGuard(
  transcription: string,
  analysis: AnnouncementAnalysis,
  sequences: readonly StopSequenceContext[],
  reason: "empty_output" | "invalid_output",
): NormalizationGuard {
  return {
    ...checkNormalization(transcription, "", analysis, sequences),
    accepted: false,
    risk: "high",
    warnings: [{ type: "output_format_failure" }],
    reason,
  };
}

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
      responseText,
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
    const parsed = GeminiAnalysisSchema.parse(JSON.parse(generated.responseText) as unknown);
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
    let raw: unknown;
    try {
      raw = JSON.parse(generated.responseText) as unknown;
    } catch {
      return {
        normalizedTranscription: transcription,
        entities: [],
        diagnostics: generated.diagnostics,
        normalizationGuard: failedNormalizationGuard(transcription, analysis, sequences, "invalid_output"),
      };
    }
    const emptyOutput = typeof raw === "object" && raw !== null
      && "normalizedTranscription" in raw && raw.normalizedTranscription === "";
    if (emptyOutput) {
      return {
        normalizedTranscription: transcription,
        entities: [],
        diagnostics: generated.diagnostics,
        normalizationGuard: failedNormalizationGuard(transcription, analysis, sequences, "empty_output"),
      };
    }
    const parsedResult = GeminiNormalizationSchema.safeParse(raw);
    if (!parsedResult.success) {
      return {
        normalizedTranscription: transcription,
        entities: [],
        diagnostics: generated.diagnostics,
        normalizationGuard: failedNormalizationGuard(transcription, analysis, sequences, "invalid_output"),
      };
    }
    const parsed = parsedResult.data;
    const normalizationGuard = checkNormalization(
      transcription,
      parsed.normalizedTranscription,
      analysis,
      sequences,
      parsed.entities,
    );
    return {
      normalizedTranscription: normalizationGuard.accepted ? parsed.normalizedTranscription : transcription,
      entities: normalizationGuard.accepted ? parsed.entities : [],
      diagnostics: generated.diagnostics,
      normalizationGuard,
    };
  }
}
