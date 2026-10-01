import { multilingualSupport } from "./multilingual-evidence";
import { mergeMentionCandidates } from "./candidate-evidence";
import type { SequenceRole, StationMention } from "../metadata/service";
import {
  StationCandidateService,
  reconcileStationMentionCandidates,
  type StationCandidateDiagnostics,
  type StationRepository,
} from "./candidate-service";
import { groupStationSequences } from "./stop-sequences";
import type { Station, StationCandidate, StationContext } from "./types";

export type UnresolvedCorrectionReason =
  | "no_candidate"
  | "no_route_support"
  | "low_confidence"
  | "ambiguous_candidates"
  | "normalization_skipped";
export type StationCorrectionFunnel = {
  extractedMentions: number;
  sequencedMentions: number;
  mentionsWithCandidates: number;
  routeSupportedMentions: number;
  boundMentions: number;
  correctedMentions: number;
  unresolvedMentions: number;
};
export type CorrectionSequence = {
  id: number;
  role: SequenceRole;
  mentions: StationMention[];
  contextMentions: StationMention[];
  stationSearch: StationCandidateDiagnostics;
};
export type StationCorrectionInput = {
  transcription: string;
  mentions: readonly StationMention[];
  context: StationContext;
};
export type StationMentionEvidence = {
  mention: StationMention;
  candidates: StationCandidateDiagnostics["mentionCandidates"][number];
};
export type StationCorrectionResult = {
  sequenceSearches: CorrectionSequence[];
  mentionEvidence: StationMentionEvidence[];
  routeHypotheses: StationCandidateDiagnostics["routeCandidates"];
  unresolvedMentions: {
    mentionId: string;
    reason: UnresolvedCorrectionReason;
  }[];
  funnel: StationCorrectionFunnel;
  metrics: {
    totalMs: number;
    reconciliationMs: number;
    sequences: StationCandidateDiagnostics["metrics"][];
  };
  candidates: StationCandidate[];
  bindings: Map<string, Station>;
};

// Bounded workers retain input order and share a job-scoped repository cache.
export async function mapConcurrent<I, O>(
  values: readonly I[],
  concurrency: number,
  run: (value: I) => Promise<O>,
): Promise<O[]> {
  const results: O[] = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await run(values[index]!);
      }
    }),
  );
  return results;
}

export class StationCorrectionEngine {
  constructor(private readonly repositoryFactory: () => StationRepository) {}
  async run(
    input: StationCorrectionInput,
    signal?: AbortSignal,
  ): Promise<StationCorrectionResult> {
    const startedAt = Date.now();
    const sequences = groupStationSequences([...input.mentions]).filter(
      ({ role }) => role !== "unknown",
    );
    const sequenceSearches = await mapConcurrent(
      sequences,
      3,
      async ({ id, role, mentions, contextMentions }) => {
        signal?.throwIfAborted();
        const searchMentions = [...mentions, ...contextMentions];
        const stationSearch = await new StationCandidateService(
          this.repositoryFactory(),
        ).analyzeMentions(
          searchMentions.map(({ text }) => text),
          input.context,
          {
            sequenceRole: role,
            destinationContext: contextMentions.length > 0,
            phoneticHints: searchMentions.map(
              ({ phoneticHint }) => phoneticHint ?? null,
            ),
          },
        );
        signal?.throwIfAborted();
        return { id, role, mentions, contextMentions, stationSearch };
      },
    );
    const supportPlans = sequenceSearches.map((sequence) =>
      multilingualSupport(sequence, sequenceSearches),
    );
    await mapConcurrent(sequenceSearches, 3, async (sequence) => {
      const support = supportPlans[sequenceSearches.indexOf(sequence)];
      if (!support) return;
      signal?.throwIfAborted();
      const oldMetrics = sequence.stationSearch.metrics;
      const searchMentions = [
        ...sequence.mentions,
        ...sequence.contextMentions,
      ];
      const updated = await new StationCandidateService(
        this.repositoryFactory(),
      ).analyzeMentions(
        searchMentions.map((m) => m.text),
        input.context,
        {
          sequenceRole: sequence.role,
          phoneticHints: searchMentions.map((m) => m.phoneticHint ?? null),
          supportingStations: support.stations,
        },
      );
      // Additive work must remain visible rather than replacing initial costs.
      for (const key of [
        "d1QueryCount",
        "candidateRowsReturned",
        "d1RowsRead",
        "candidateGenerationMs",
        "lineLookupMs",
        "lineRouteLoadingMs",
        "hypothesisGenerationMs",
        "graphSearchMs",
        "alignmentMs",
        "totalMs",
        "alignmentComparisonCount",
        "graphSearchCount",
        "cacheHits",
        "cacheMisses",
      ] as const) {
        updated.metrics[key] =
          (updated.metrics[key] ?? 0) + (oldMetrics[key] ?? 0);
      }
      updated.mentionCandidates.forEach((candidates, index) => {
        const evidence = support.evidence[index];
        if (!evidence) return;
        for (const candidate of candidates)
          if (candidate.station.id === evidence.stationId)
            candidate.crossLanguageEvidence = [evidence];
      });
      sequence.stationSearch = updated;
      signal?.throwIfAborted();
    });
    const reconciliationStartedAt = Date.now();
    const bindings = reconcileStationMentionCandidates(
      sequenceSearches.map(({ stationSearch }) => stationSearch),
    );
    const reconciliationMs = Date.now() - reconciliationStartedAt;
    const byMention = new Map<string, StationMentionEvidence>(
      input.mentions.map((mention) => [
        mention.id ?? `${mention.start}:${mention.end}`,
        { mention, candidates: [] },
      ]),
    );
    const sequenced = new Set<string>();
    const candidateMap = new Map<number, StationCandidate>();
    for (const sequence of sequenceSearches) {
      [...sequence.mentions, ...sequence.contextMentions].forEach(
        (mention, index) => {
          const key = mention.id ?? `${mention.start}:${mention.end}`;
          sequenced.add(key);
          const candidates =
            sequence.stationSearch.mentionCandidates[index] ?? [];
          const existing = byMention.get(key);
          byMention.set(key, {
            mention,
            candidates: mergeMentionCandidates([
              existing?.candidates ?? [],
              candidates,
            ]).slice(0, 5),
          });
        },
      );
      for (const candidate of sequence.stationSearch.candidates) {
        const old = candidateMap.get(candidate.station.id);
        if (
          !old ||
          candidate.score > old.score ||
          (candidate.score === old.score &&
            candidate.routeSupported &&
            !old.routeSupported)
        )
          candidateMap.set(candidate.station.id, candidate);
      }
    }
    const mentionEvidence = [...byMention.values()];
    const unresolvedMentions = mentionEvidence
      .filter(({ candidates }) => !candidates.some((c) => c.bound))
      .map(({ mention, candidates }) => ({
        mentionId: mention.id ?? `${mention.start}:${mention.end}`,
        reason:
          candidates.length === 0
            ? ("no_candidate" as const)
            : candidates[0]!.bestRouteScore === null
              ? ("no_route_support" as const)
              : candidates[0]!.finalScore - (candidates[1]?.finalScore ?? 0) <
                  0.1
                ? ("ambiguous_candidates" as const)
                : ("low_confidence" as const),
      }));
    return {
      sequenceSearches,
      mentionEvidence,
      unresolvedMentions,
      candidates: [...candidateMap.values()],
      bindings,
      routeHypotheses: sequenceSearches.flatMap(
        (s) => s.stationSearch.routeCandidates,
      ),
      funnel: {
        extractedMentions: input.mentions.length,
        sequencedMentions: sequenced.size,
        mentionsWithCandidates: mentionEvidence.filter(
          (e) => e.candidates.length > 0,
        ).length,
        routeSupportedMentions: mentionEvidence.filter((e) =>
          e.candidates.some((c) => c.bestRouteScore !== null),
        ).length,
        boundMentions: mentionEvidence.filter((e) =>
          e.candidates.some((c) => c.bound),
        ).length,
        correctedMentions: 0,
        unresolvedMentions: unresolvedMentions.length,
      },
      metrics: {
        totalMs: Date.now() - startedAt,
        reconciliationMs,
        sequences: sequenceSearches.map((s) => s.stationSearch.metrics),
      },
    };
  }
}
