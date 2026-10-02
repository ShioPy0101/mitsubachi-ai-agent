import type {
  GeminiAnalysisExtraction,
  GeminiNormalizationExtraction,
} from "../metadata/gemini";
import type { StopSequenceContext } from "../metadata/prompt";
import type { AnnouncementAnalysis } from "../metadata/service";
import type { StationCorrectionResult } from "../stations/correction-engine";

// Provider ports permit model adapters without changing the orchestration/domain.
export interface SemanticAnalyzer {
  analyze(
    text: string,
    signal?: AbortSignal,
  ): Promise<GeminiAnalysisExtraction>;
}
export interface LanguageNormalizer {
  normalize(
    text: string,
    analysis: AnnouncementAnalysis,
    sequences: readonly StopSequenceContext[],
    signal?: AbortSignal,
  ): Promise<GeminiNormalizationExtraction>;
}
export class SemanticAnalysisStage {
  constructor(private readonly provider: SemanticAnalyzer) {}
  run(text: string, signal: AbortSignal) {
    return this.provider.analyze(text, signal);
  }
}
export class NaturalLanguageNormalizationStage {
  constructor(private readonly provider: LanguageNormalizer) {}
  run(
    text: string,
    analysis: AnnouncementAnalysis,
    correction: StationCorrectionResult,
    signal: AbortSignal,
  ) {
    const sequences = correction.sequenceSearches.map(
      ({ id, role, mentions, contextMentions, stationSearch }) => ({
        id,
        role,
        mentions,
        contextMentions,
        stationCandidates: stationSearch.candidates,
        mentionCandidates: stationSearch.mentionCandidates,
        routeHypotheses: stationSearch.routeCandidates,
      }),
    );
    return this.provider.normalize(text, analysis, sequences, signal);
  }
}
