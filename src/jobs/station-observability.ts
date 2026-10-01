import type { StationSequenceMetrics } from "../stations/candidate-service";

export const STATION_PERFORMANCE_ALERT_THRESHOLDS = {
  phaseMs: 15_000,
  sequenceMs: 5_000,
  d1Queries: 12,
  alignmentComparisons: 100_000,
} as const;

export type StationSequenceObservation = {
  id: number;
  metrics: StationSequenceMetrics;
};

export class StationCandidatePerformanceWarning extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StationCandidatePerformanceWarning";
  }
}

export function formatStationCandidateJobProgress(
  sequences: readonly StationSequenceObservation[],
  phaseMs: number,
): string {
  const totals = sequences.reduce((result, { metrics }) => ({
    mentions: result.mentions + metrics.mentions,
    d1Queries: result.d1Queries + metrics.d1QueryCount,
    graphSearches: result.graphSearches + metrics.graphSearchCount,
    fallbacks: result.fallbacks + (metrics.fallbackExecuted ? 1 : 0),
    hypotheses: result.hypotheses + metrics.routeHypothesesKept,
    comparisons: result.comparisons + metrics.alignmentComparisonCount,
  }), { mentions: 0, d1Queries: 0, graphSearches: 0, fallbacks: 0, hypotheses: 0, comparisons: 0 });
  const slowest = [...sequences].sort((left, right) => right.metrics.totalMs - left.metrics.totalMs)[0];
  const slowestText = slowest === undefined
    ? "なし"
    : `#${slowest.id} ${slowest.metrics.totalMs}ms/D1 ${slowest.metrics.d1QueryCount}`;
  return [
    `完了 ${sequences.length} sequences・${totals.mentions} mentions・phase ${phaseMs}ms`,
    `D1 ${totals.d1Queries}・graph ${totals.graphSearches}・fallback ${totals.fallbacks}`,
    `hypotheses ${totals.hypotheses}・alignment ${totals.comparisons} comparisons・最遅 ${slowestText}`,
  ].join("\n");
}

export function stationCandidatePerformanceWarning(
  sequences: readonly StationSequenceObservation[],
  phaseMs: number,
): string | null {
  const slowSequences = sequences.filter(({ metrics }) =>
    metrics.totalMs >= STATION_PERFORMANCE_ALERT_THRESHOLDS.sequenceMs
    || metrics.d1QueryCount >= STATION_PERFORMANCE_ALERT_THRESHOLDS.d1Queries
    || metrics.alignmentComparisonCount >= STATION_PERFORMANCE_ALERT_THRESHOLDS.alignmentComparisons);
  if (phaseMs < STATION_PERFORMANCE_ALERT_THRESHOLDS.phaseMs && slowSequences.length === 0) return null;
  const reasons = [
    ...(phaseMs >= STATION_PERFORMANCE_ALERT_THRESHOLDS.phaseMs ? [`phase=${phaseMs}ms`] : []),
    ...slowSequences.map(({ id, metrics }) => [
      `sequence=${id}`,
      `total=${metrics.totalMs}ms`,
      `mentions=${metrics.mentions}`,
      `D1=${metrics.d1QueryCount}`,
      `graph=${metrics.graphSearchCount}`,
      `fallback=${metrics.fallbackExecuted}`,
      `hypotheses=${metrics.routeHypothesesKept}`,
      `alignment=${metrics.alignmentComparisonCount}`,
    ].join(" ")),
  ];
  return reasons.join("\n");
}
