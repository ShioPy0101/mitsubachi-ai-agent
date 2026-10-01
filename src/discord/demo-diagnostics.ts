import type { ExecutionContext } from "../pipeline/modes";
import type {
  GeminiAnalysisExtraction,
  GeminiDiagnostics,
} from "../metadata/gemini";
import type { SequenceRole } from "../metadata/service";
import type { JobTimingMetrics } from "../pipeline/timing";
import type { RailwayAnnouncementMetadata } from "../railway/types";
import {
  STATION_SEQUENCE_LIMITS,
  type StationCandidateDiagnostics,
} from "../stations/candidate-service";
import type {
  StationCorrectionFunnel,
  UnresolvedCorrectionReason,
} from "../stations/correction-engine";
import {
  STATION_MATCH_WEIGHTS,
  type StationResolution,
} from "../stations/types";
import type { TranscriptionResult } from "../transcription/service";

export type DemoDiagnostics = {
  executionContext?: ExecutionContext;
  jobTiming?: JobTimingMetrics;
  correctionFunnel?: StationCorrectionFunnel;
  unresolvedMentions?: {
    mentionId: string;
    reason: UnresolvedCorrectionReason;
  }[];
  injectionDiagnostic?: boolean;
  missedMentionSurfaces?: string[];
  audioInput: {
    filename: string;
    contentType: string | null;
    sizeBytes: number;
    durationSecs: number | null;
  };
  whisper: {
    model: string;
    settings: unknown;
    result: TranscriptionResult;
  };
  transcription: string;
  analysis: GeminiAnalysisExtraction;
  sequenceSearches: Array<{
    id: number;
    role: SequenceRole;
    mentions: GeminiAnalysisExtraction["mentions"];
    contextMentions: GeminiAnalysisExtraction["mentions"];
    stationSearch: StationCandidateDiagnostics;
  }>;
  gemini: GeminiDiagnostics;
  isTransitAnnouncement: boolean;
  normalizedTranscription: string;
  metadata: RailwayAnnouncementMetadata;
  resolution: StationResolution;
  filename: string;
};

const messageLimit = 2_000;

function fenceFor(value: string): string {
  const longest = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/gu), (match) => match[0].length),
  );
  return "`".repeat(Math.max(3, longest + 1));
}

function codeMessages(
  title: string,
  language: string,
  value: string,
): string[] {
  const fence = fenceFor(value);
  const parts: string[] = [];
  let offset = 0;
  while (offset < value.length || parts.length === 0) {
    const provisionalHeader = `**${title}** (999/999)\n${fence}${language}\n`;
    const footer = `\n${fence}`;
    const size = Math.max(
      1,
      messageLimit - provisionalHeader.length - footer.length,
    );
    parts.push(value.slice(offset, offset + size));
    offset += size;
  }
  return parts.map((part, index) => {
    const suffix = parts.length === 1 ? "" : ` (${index + 1}/${parts.length})`;
    return `**${title}**${suffix}\n${fence}${language}\n${part}\n${fence}`;
  });
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function clipped(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength)}\n…（完全版は添付ファイルを参照）`;
}

function fenced(language: string, value: string): string {
  const fence = fenceFor(value);
  return `${fence}${language}\n${value}\n${fence}`;
}

function routeSummary(diagnostics: StationCandidateDiagnostics): unknown {
  return {
    extractedSearchText: diagnostics.searchText,
    context: diagnostics.context,
    algorithmLimits: {
      surfaceCandidatesPerMention:
        STATION_SEQUENCE_LIMITS.surfaceCandidatesPerMention,
      phoneticCandidatesPerMention:
        STATION_SEQUENCE_LIMITS.phoneticCandidatesPerMention,
      uniqueCandidatesPerMention:
        STATION_SEQUENCE_LIMITS.uniqueCandidatesPerMention,
      anchors: 12,
      lineHypotheses: STATION_SEQUENCE_LIMITS.lineHypotheses,
      routeHypotheses: STATION_SEQUENCE_LIMITS.routeHypotheses,
      fallbackSeeds: STATION_SEQUENCE_LIMITS.fallbackSeeds,
      fallbackRoutes: STATION_SEQUENCE_LIMITS.fallbackRoutes,
      maximumStationGap: { stops: 4, direction: 16 },
      minimumSequenceLexicalCoverage: 0.5,
      minimumSequenceScore: 0.43,
      minimumCandidateScore: 0.35,
      finalCandidates: 24,
    },
    scoringWeights: STATION_MATCH_WEIGHTS,
    candidatePoolCount: diagnostics.pool.length,
    eligiblePoolCount: diagnostics.eligiblePool.length,
    anchorsInSpokenOrder: diagnostics.anchorNames,
    anchorSearchStatus: diagnostics.anchorSearchStatus,
    routeSearchStatus: diagnostics.routeSearchStatus,
    sequenceFallbackAttempted: diagnostics.sequenceFallbackAttempted,
    fallbackSearchStatus: diagnostics.fallbackSearchStatus,
    metrics: diagnostics.metrics,
    mentionCandidates: diagnostics.mentionCandidates,
    searchedRouteCandidates: diagnostics.routeCandidates.map((route, rank) => ({
      rank,
      anchorCoverage: route.anchorCoverage,
      orderConsistency: route.orderConsistency,
      transferCount: route.transferCount,
      pathLength: route.pathLength,
      score: route.score,
      source: route.source,
      mentionMatches: route.mentionMatches,
      path: route.stations.map(({ station, routeIndex }) => ({
        routeIndex,
        id: station.id,
        name: station.name,
        lineName: station.lineName,
      })),
    })),
  };
}

export function formatDemoDiagnostics(value: DemoDiagnostics): string[] {
  const messages = [
    ...codeMessages("1. 音声入力", "json", json(value.audioInput)),
    ...codeMessages(
      "2. Whisperリクエスト設定",
      "json",
      json({
        model: value.whisper.model,
        ...(value.whisper.settings as object),
        audio: `[base64 omitted: ${value.audioInput.sizeBytes} source bytes]`,
      }),
    ),
    ...codeMessages(
      "3. Whisper解析結果（言語・セグメント）",
      "json",
      json(value.whisper.result),
    ),
    ...codeMessages(
      "4. Whisper文字起こし（Gemini入力元）",
      "text",
      value.transcription,
    ),
    ...codeMessages(
      "5. Gemini #1 リクエスト（秘密値除外）",
      "json",
      json(value.gemini.analysis.request),
    ),
    ...codeMessages(
      "6. Gemini #1 完全なプロンプト",
      "text",
      value.gemini.analysis.prompt,
    ),
    ...codeMessages(
      "7. Gemini #1 raw response",
      "json",
      json(value.gemini.analysis.response),
    ),
    ...codeMessages(
      "8. parsed station mentions",
      "json",
      json(value.analysis.mentions),
    ),
    ...value.sequenceSearches.flatMap((sequence) => [
      ...codeMessages(
        `9.${sequence.id}. ${sequence.role} sequence ${sequence.id} 構造`,
        "json",
        json({
          id: sequence.id,
          role: sequence.role,
          mentions: sequence.mentions,
          contextMentions: sequence.contextMentions,
          search: routeSummary(sequence.stationSearch),
        }),
      ),
      ...codeMessages(
        `10.${sequence.id}. ${sequence.role} sequence ${sequence.id} 駅候補`,
        "json",
        json(sequence.stationSearch.candidates),
      ),
    ]),
    ...codeMessages(
      "11. Gemini #2 リクエスト（秘密値除外）",
      "json",
      json(value.gemini.normalization.request),
    ),
    ...codeMessages(
      "12. Gemini #2 完全なプロンプト",
      "text",
      value.gemini.normalization.prompt,
    ),
    ...codeMessages(
      "13. Gemini #2 raw response",
      "json",
      json(value.gemini.normalization.response),
    ),
    ...codeMessages(
      "14. 補正後文字起こし",
      "text",
      value.normalizedTranscription,
    ),
    ...codeMessages(
      "15. 最終解析結果",
      "json",
      json({
        normalizationObservation: value.gemini.normalizationObservation,
        execution: value.executionContext,
        jobTiming: value.jobTiming,
        correctionFunnel: value.correctionFunnel,
        unresolvedMentions: value.unresolvedMentions,
        missedMentionSurfaces: value.missedMentionSurfaces,
        promptInjectionDiagnostic: value.injectionDiagnostic,
        isTransitAnnouncement: value.isTransitAnnouncement,
        metadata: value.metadata,
        stationResolution: value.resolution,
        generatedFilename: value.filename,
      }),
    ),
  ];
  return messages;
}

export function formatDemoDiagnosticPreviews(value: DemoDiagnostics): string[] {
  const sequenceSummary =
    value.sequenceSearches
      .map((sequence) => {
        const routes = sequence.stationSearch.routeCandidates
          .slice(0, 3)
          .map(
            (route) =>
              `${route.stations.map(({ station }) => station.name).join(" → ")} (score=${route.score.toFixed(3)})`,
          )
          .join("\n");
        const context =
          sequence.contextMentions.length === 0
            ? ""
            : ` / context=${sequence.contextMentions.map(({ text, role }) => `${text}[${role}]`).join(" → ")}`;
        return `sequence ${sequence.id} [${sequence.role}]: ${sequence.mentions.map(({ text, role }) => `${text}[${role}]`).join(" → ")}${context}\nstatus=${sequence.stationSearch.routeSearchStatus} / fallback=${sequence.stationSearch.sequenceFallbackAttempted}\n${routes || "経路候補なし"}`;
      })
      .join("\n\n") || "経路探索sequenceなし";
  const analysisRequest = (value.gemini.analysis.request ?? {}) as {
    endpoint?: unknown;
  };
  const normalizationRequest = (value.gemini.normalization.request ?? {}) as {
    endpoint?: unknown;
  };

  return [
    [
      "**🎙️ Whisper**",
      `ファイル: ${value.audioInput.filename} (${value.audioInput.sizeBytes} bytes, ${value.audioInput.contentType ?? "type不明"})`,
      `モデル: ${value.whisper.model}`,
      `検出言語: ${value.whisper.result.language ?? "不明"} / セグメント: ${value.whisper.result.segments.length}件`,
      "文字起こし:",
      fenced("text", clipped(value.transcription, 1_200)),
    ].join("\n"),
    [
      "**🧩 Gemini #1 構造解析**",
      `送信先: ${typeof analysisRequest.endpoint === "string" ? analysisRequest.endpoint : "不明"}`,
      "APIキー: [REDACTED]",
      `交通案内判定: ${value.analysis.isTransitAnnouncement} / mention: ${value.analysis.mentions.length}件`,
      "parsed station mentions:",
      fenced("json", clipped(json(value.analysis.mentions), 1_350)),
    ].join("\n"),
    [
      "**🚉 sequence別の駅・経路探索**",
      fenced("text", clipped(sequenceSummary, 1_600)),
    ].join("\n"),
    [
      "**🤖 Gemini #2 制約付き補正**",
      `送信先: ${typeof normalizationRequest.endpoint === "string" ? normalizationRequest.endpoint : "不明"}`,
      "Gemini #2 raw response:",
      fenced("json", clipped(json(value.gemini.normalization.response), 1_400)),
    ].join("\n"),
    [
      "**✅ 最終判定**",
      fenced(
        "json",
        clipped(
          json({
            normalizationObservation: value.gemini.normalizationObservation,
            execution: value.executionContext,
            jobTiming: value.jobTiming,
            correctionFunnel: value.correctionFunnel,
            unresolvedMentions: value.unresolvedMentions,
            missedMentionSurfaces: value.missedMentionSurfaces,
            promptInjectionDiagnostic: value.injectionDiagnostic,
            normalizedTranscription: value.normalizedTranscription,
            metadata: value.metadata,
            stationResolution: value.resolution,
            generatedFilename: value.filename,
          }),
          1_600,
        ),
      ),
    ].join("\n"),
  ];
}
