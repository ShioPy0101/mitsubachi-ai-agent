import {
  englishStationReading,
  localizedStationSimilarity,
  normalizeLocalizedStationName,
} from "./language";
import { StationSimilarityCache, stringSimilarity } from "./similarity";
import type { SequenceRole } from "../metadata/service";
import {
  extractStationSearchText,
  normalizeKana,
  normalizeStationName,
} from "./normalization";
import {
  bestContainedSimilarity,
  stationKanaSimilarity,
  stationNameMentionSimilarity,
} from "./similarity";
import {
  STATION_MATCH_WEIGHTS,
  type MentionRouteMatch,
  type MentionStationCandidate,
  type RoutePathCandidate,
  type RouteSearchStatus,
  type Station,
  type StationCandidate,
  type StationContext,
} from "./types";

export interface StationRepository {
  getQueryCount?(): number;
  getCostMetrics?(): {
    rowsReturned: number;
    d1RowsRead?: number;
    cacheHits: number;
    cacheMisses: number;
    lineRouteLoadingMs?: number;
    sequencePreRankComparisons?: number;
    work?: import("./work-metrics").RailwayWorkMetrics;
    candidateSource?: {
      queries: number;
      rowsRead?: number;
      postingRows: number;
      returnedIds: number;
    };
  };
  findCandidatePool(
    searchText: string,
    context: StationContext,
    limit: number,
  ): Promise<Station[]>;
  findCandidatePools?(
    surfaceTexts: readonly string[],
    phoneticHints: readonly (string | null)[],
    context: StationContext,
    surfaceLimit: number,
    phoneticLimit: number,
  ): Promise<{ surface: Station[][]; phonetic: Station[][] }>;
  findSequenceLineRouteCandidates?(
    mentions: readonly string[],
    hints: readonly (string | null)[],
    maxLines: number,
  ): Promise<RoutePathCandidate[]>;
  findLineRouteCandidates?(
    candidates: readonly LineCandidateSeed[],
    maxLines: number,
  ): Promise<RoutePathCandidate[]>;
  findRouteCandidates(
    anchorNames: readonly string[],
    maxCandidates: number,
    endpointContextStations?: number,
  ): Promise<RoutePathCandidate[]>;
}

export type LineCandidateSeed = {
  stationId: number;
  mentionIndex: number;
  strength: number;
};

export const STATION_SEQUENCE_LIMITS = {
  surfaceCandidatesPerMention: 3,
  phoneticCandidatesPerMention: 2,
  uniqueCandidatesPerMention: 5,
  lineHypotheses: 2,
  routeHypotheses: 5,
  fallbackSeeds: 4,
  fallbackRoutes: 3,
  routeLength: 256,
  alignmentComparisons: 100_000,
} as const;

export type SequenceSearchOptions = {
  matchingStrategy?: "strict" | "contained";
  alignmentBudget?: number;
  sequenceRole?: SequenceRole;
  destinationContext?: boolean;
  phoneticHints?: readonly (string | null)[];
  bindings?: ReadonlyMap<string, Station>;
  supportingStations?: readonly (Station | null)[];
};

export type StationCandidateDiagnostics = {
  searchText: string;
  context: StationContext;
  pool: Station[];
  eligiblePool: Station[];
  anchorNames: string[];
  anchorSearchStatus:
    "matched" | "insufficient_anchors" | "inconsistent_anchors";
  routeSearchStatus: RouteSearchStatus;
  sequenceFallbackAttempted: boolean;
  fallbackSearchStatus: "not_attempted" | "matched" | "no_route_match";
  mentionCandidates: MentionStationCandidate[][];
  routeCandidates: RoutePathCandidate[];
  candidates: StationCandidate[];
  metrics: StationSequenceMetrics;
  strategyComparison?: {
    selected: "strict" | "contained";
    reason:
      | "only_matched_strategy"
      | "stronger_shared_lexical_evidence"
      | "strict_tie_break"
      | "neither_matched";
    attempts: {
      strategy: "strict" | "contained";
      status: RouteSearchStatus;
      score: number;
      routeStations: string[];
      fallback: boolean;
      totalMs: number;
      graphSearchCount: number;
    }[];
  };
};

export type StationSequenceMetrics = {
  mentions: number;
  candidateRowsReturned?: number;
  d1RowsRead?: number;
  cacheHits?: number;
  cacheMisses?: number;
  surfaceCandidateCount: number;
  phoneticCandidateCount: number;
  uniqueCandidateCount: number;
  lineIdsLoaded: number;
  routeHypothesesGenerated: number;
  routeHypothesesKept: number;
  graphSearchCount: number;
  fallbackExecuted: boolean;
  fallbackSeedCount: number;
  alignmentRouteCount: number;
  alignmentComparisonCount: number;
  d1QueryCount: number;
  sequencePreRankComparisons?: number;
  candidateGenerationMs: number;
  lineLookupMs: number;
  lineRouteLoadingMs?: number;
  hypothesisGenerationMs: number;
  graphSearchMs: number;
  alignmentMs: number;
  reconciliationMs: number;
  totalMs: number;
};

function adjacencyScore(station: Station, context: StationContext): number {
  const previous = context.previousStation;
  const next = context.nextStation;
  const previousMatches =
    previous != null &&
    (station.prevStation === previous || station.nextStation === previous);
  const nextMatches =
    next != null &&
    (station.prevStation === next || station.nextStation === next);
  return previousMatches || nextMatches ? 1 : 0;
}

function isEligibleStationMention(
  station: Station,
  transcription: string,
): boolean {
  if (Array.from(station.name).length > 1) return true;
  const escapedName = station.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const normalized = transcription.normalize("NFKC");
  if (normalized.includes(`${station.name}駅`)) return true;
  return new RegExp(
    `(?:次は|つぎは|まもなく|こちらは)[\\s、,「『]*${escapedName}(?:です|でございます|に到着|[、。,.!?！？」』])`,
    "u",
  ).test(normalized);
}

export function scoreStation(
  station: Station,
  transcription: string,
  context: StationContext,
  cache?: StationSimilarityCache,
): StationCandidate {
  const nameSimilarity = cache
    ? cache.similarity(
        cache.normalize(transcription, "name"),
        cache.normalize(station.name, "name"),
        true,
      )
    : bestContainedSimilarity(
        normalizeStationName(transcription),
        normalizeStationName(station.name),
      );
  const kanaSimilarity = stationKanaSimilarity(
    transcription,
    station.kana,
    cache,
  );
  const lineBonus =
    context.lineName != null && station.lineName === context.lineName ? 1 : 0;
  const prefectureBonus =
    context.prefecture != null && station.prefecture === context.prefecture
      ? 1
      : 0;
  const adjacencyBonus = adjacencyScore(station, context);
  const score = Math.min(
    1,
    nameSimilarity * STATION_MATCH_WEIGHTS.name +
      kanaSimilarity * STATION_MATCH_WEIGHTS.kana +
      lineBonus * STATION_MATCH_WEIGHTS.line +
      prefectureBonus * STATION_MATCH_WEIGHTS.prefecture +
      adjacencyBonus * STATION_MATCH_WEIGHTS.adjacency,
  );
  return {
    station,
    nameSimilarity,
    kanaSimilarity,
    lineBonus,
    prefectureBonus,
    adjacencyBonus,
    routeContextBonus: 0,
    routeSupported: false,
    onExactPath: false,
    nearPath: false,
    routeOrderConsistent: false,
    routeIndex: null,
    previousAnchor: null,
    nextAnchor: null,
    routeCandidateIds: [],
    bestRouteRank: null,
    anchor: false,
    score,
  };
}

function mentionIndex(station: Station, transcription: string): number {
  const nameIndex = normalizeStationName(transcription).indexOf(
    normalizeStationName(station.name),
  );
  const kanaIndex =
    station.kana === null
      ? -1
      : normalizeKana(transcription).indexOf(normalizeKana(station.kana));
  if (nameIndex < 0) return kanaIndex;
  if (kanaIndex < 0) return nameIndex;
  return Math.min(nameIndex, kanaIndex);
}

export function lexicalSimilarities(
  mention: string,
  station: Station,
  inferredReading?: string | null,
  cache?: StationSimilarityCache,
): {
  nameSimilarity: number;
  kanaSimilarity: number;
  phoneticSimilarity: number;
  lexicalSimilarity: number;
} {
  const localized = localizedStationSimilarity(mention, station);
  const nameSimilarity = localized
    ? cache
      ? cache.similarity(
          cache.normalize(mention, "localized"),
          cache.normalize(localized, "localized"),
        )
      : stringSimilarity(
          normalizeLocalizedStationName(mention),
          normalizeLocalizedStationName(localized),
        )
    : stationNameMentionSimilarity(mention, station.name, cache);
  const kanaSimilarity = stationKanaSimilarity(mention, station.kana, cache);
  const phoneticSimilarity =
    inferredReading == null
      ? 0
      : stationKanaSimilarity(inferredReading, station.kana, cache);
  return {
    nameSimilarity,
    kanaSimilarity,
    phoneticSimilarity,
    // An inferred reading can rescue a candidate, but cannot become as strong as
    // direct surface or kana evidence by itself.
    lexicalSimilarity: Math.max(
      nameSimilarity,
      kanaSimilarity,
      phoneticSimilarity * 0.5,
    ),
  };
}

export function stationMentionBindingKey(rawMention: string): string {
  return normalizeStationName(rawMention);
}

function alignMentionsToRoute(
  mentionTexts: readonly string[],
  phoneticHints: readonly (string | null)[],
  route: RoutePathCandidate,
  source: "line_fast_path" | "graph_fallback",
  hardAnchorNamesByMention: readonly ReadonlySet<string>[],
  boundNamesByMention: readonly (string | null)[],
  onComparison?: () => void,
  similaritiesFor = lexicalSimilarities,
  similarityCache?: StationSimilarityCache,
): RoutePathCandidate | null {
  if (
    mentionTexts.length < 2 ||
    route.stations.length < mentionTexts.length ||
    route.stations.length > STATION_SEQUENCE_LIMITS.routeLength
  )
    return null;
  if (
    mentionTexts.length * route.stations.length >
    STATION_SEQUENCE_LIMITS.alignmentComparisons
  )
    return null;
  const alignmentValue = (mentionIndex: number, station: Station): number => {
    const similarities = similaritiesFor(
      mentionTexts[mentionIndex] ?? "",
      station,
      phoneticHints[mentionIndex],
    );
    const lexical =
      stationNameMentionSimilarity(
        mentionTexts[mentionIndex] ?? "",
        station.name,
        similarityCache,
      ) *
        0.15 +
      similarities.nameSimilarity * 0.75 +
      similarities.kanaSimilarity * 0.35 +
      similarities.phoneticSimilarity * 0.15;
    const hardNames =
      hardAnchorNamesByMention[mentionIndex] ?? new Set<string>();
    const boundName = boundNamesByMention[mentionIndex];
    if (boundName !== null && boundName !== undefined)
      return station.name === boundName ? lexical + 1 : lexical - 2;
    if (hardNames.size === 0) return lexical;
    return lexical + (hardNames.has(station.name) ? 0.5 : -0.35);
  };
  type Alignment = { value: number; indexes: number[] };
  let previous = route.stations.map((item, routeIndex): Alignment => {
    return { value: alignmentValue(0, item.station), indexes: [routeIndex] };
  });
  for (
    let mentionIndex = 1;
    mentionIndex < mentionTexts.length;
    mentionIndex += 1
  ) {
    // Prefix maximum gives ordered-subsequence alignment in O(mentions × path).
    // Passing any number of unspoken stations is valid; distance is not a stop
    // count or a reason to discard an otherwise ordered railway route.
    let prefixBest: Alignment | null = null;
    const current = route.stations.map((item, routeIndex): Alignment => {
      const older = previous[routeIndex - 3];
      if (older) {
        onComparison?.();
        if (!prefixBest || older.value > prefixBest.value) prefixBest = older;
      }
      // A tiny capped proximity preference breaks ambiguous lexical ties.
      // It never grows with route length or imposes a station-gap limit.
      let bestPrior: Alignment | null = prefixBest
        ? { value: prefixBest.value - 0.06, indexes: prefixBest.indexes }
        : null;
      for (const gap of [1, 2]) {
        const prior = previous[routeIndex - gap];
        if (!prior) continue;
        onComparison?.();
        const value = prior.value - (gap - 1) * 0.03;
        if (!bestPrior || value > bestPrior.value)
          bestPrior = { value, indexes: prior.indexes };
      }
      return bestPrior && Number.isFinite(bestPrior.value)
        ? {
            value:
              bestPrior.value +
              alignmentValue(mentionIndex, item.station) +
              0.2,
            indexes: [...bestPrior.indexes, routeIndex],
          }
        : { value: Number.NEGATIVE_INFINITY, indexes: [] };
    });
    previous = current;
  }
  const best = previous.reduce<Alignment | null>(
    (selected, item) =>
      selected === null || item.value > selected.value ? item : selected,
    null,
  );
  if (best === null || best.indexes.length !== mentionTexts.length) return null;
  const refinedIndexes = [...best.indexes];
  // Resolve equal lexical-strength ties using an exact reading on the aligned
  // path, including sequence boundaries. Require strong available neighbours.
  // This changes route material, never hard binding, and
  // preserves every ordering constraint and the existing scoring thresholds.
  for (let i = 0; i < mentionTexts.length; i++) {
    const hint = phoneticHints[i];
    if (!hint || hardAnchorNamesByMention[i]?.size || boundNamesByMention[i])
      continue;
    const current = lexicalSimilarities(
      mentionTexts[i]!,
      route.stations[refinedIndexes[i]!]!.station,
      hint,
      similarityCache,
    );
    if (Math.max(current.nameSimilarity, current.kanaSimilarity) >= 0.85)
      continue;
    const left = i === 0 ? -1 : refinedIndexes[i - 1]!,
      right =
        i === mentionTexts.length - 1
          ? route.stations.length
          : refinedIndexes[i + 1]!;
    const neighboursStrong = [i - 1, i + 1]
      .filter((j) => j >= 0 && j < mentionTexts.length)
      .every((j) => {
        const evidence = lexicalSimilarities(
          mentionTexts[j]!,
          route.stations[refinedIndexes[j]!]!.station,
          null,
          similarityCache,
        );
        return (
          Math.max(evidence.nameSimilarity, evidence.kanaSimilarity) >= 0.65
        );
      });
    if (!neighboursStrong) continue;
    const exactReadingIndexes: number[] = [];
    for (let index = left + 1; index < right; index++) {
      onComparison?.();
      const station = route.stations[index]!.station;
      if (
        !station.kana ||
        (similarityCache?.normalize(hint, "kana") ?? normalizeKana(hint)) !==
          (similarityCache?.normalize(station.kana, "kana") ??
            normalizeKana(station.kana))
      )
        continue;
      const evidence = lexicalSimilarities(
        mentionTexts[i]!,
        station,
        hint,
        similarityCache,
      );
      if (
        Math.abs(evidence.lexicalSimilarity - current.lexicalSimilarity) <
          1e-9 &&
        evidence.phoneticSimilarity > current.phoneticSimilarity
      )
        exactReadingIndexes.push(index);
    }
    // Multiple matching physical positions remain ambiguous.
    if (exactReadingIndexes.length === 1)
      refinedIndexes[i] = exactReadingIndexes[0]!;
  }
  const mentionMatches: MentionRouteMatch[] = refinedIndexes.map(
    (routeIndex, mentionIndex) => {
      const station = route.stations[routeIndex]!.station;
      return {
        mentionIndex,
        mentionText: mentionTexts[mentionIndex] ?? "",
        station,
        routeIndex,
        ...similaritiesFor(
          mentionTexts[mentionIndex] ?? "",
          station,
          phoneticHints[mentionIndex],
        ),
      };
    },
  );
  if (
    mentionMatches.some((match) => {
      const boundName = boundNamesByMention[match.mentionIndex];
      return (
        boundName !== null &&
        boundName !== undefined &&
        match.station.name !== boundName
      );
    })
  )
    return null;
  const lexicalValues = mentionMatches.map(
    ({ lexicalSimilarity }) => lexicalSimilarity,
  );
  const hardAnchorMatches = mentionMatches.filter((match) => {
    const hardNames =
      hardAnchorNamesByMention[match.mentionIndex] ?? new Set<string>();
    return hardNames.size > 0 && hardNames.has(match.station.name);
  }).length;
  const hardAnchorViolations = mentionMatches.filter((match) => {
    const hardNames =
      hardAnchorNamesByMention[match.mentionIndex] ?? new Set<string>();
    return hardNames.size > 0 && !hardNames.has(match.station.name);
  });
  const hardAnchorCount = hardAnchorNamesByMention.filter(
    (names) => names.size > 0,
  ).length;
  const exactAnchorCoverage =
    hardAnchorCount === 0 ? 1 : hardAnchorMatches / hardAnchorCount;
  const hardAnchorViolationRatio =
    hardAnchorCount === 0 ? 0 : hardAnchorViolations.length / hardAnchorCount;
  // A coherent route that already explains most hard anchors must not discard
  // another hard station with a zero-similarity replacement. When several exact
  // ASR matches contradict one another (for example accidental real station
  // names), retain the existing sequence-level route comparison instead.
  const coherentHardEvidence =
    hardAnchorCount === 1 || exactAnchorCoverage >= 0.6;
  if (
    (coherentHardEvidence || hardAnchorCount === mentionTexts.length) &&
    hardAnchorViolations.some(
      ({ lexicalSimilarity }) =>
        hardAnchorCount === mentionTexts.length || lexicalSimilarity === 0,
    )
  )
    return null;
  const covered = lexicalValues.filter((value) => value >= 0.4).length;
  const strong = lexicalValues.filter((value) => value >= 0.65).length;
  // Valid increasing physical indexes are sufficient for stop-list continuity.

  const meanLexical =
    lexicalValues.reduce((sum, value) => sum + value, 0) / lexicalValues.length;
  const anchorCoverage = covered / mentionTexts.length;
  const score = Math.max(
    0,
    Math.min(
      1,
      meanLexical * 0.5 +
        anchorCoverage * 0.3 +
        (strong / mentionTexts.length) * 0.15 +
        (hardAnchorCount === 0 ? 0 : exactAnchorCoverage * 0.15) -
        hardAnchorViolationRatio * 0.1 -
        route.transferCount * 0.015 -
        (route.detourRatio ?? 0) * 0.2 -
        (route.directionReversals ?? 0) * 0.15,
    ),
  );
  if (
    covered < Math.max(2, Math.ceil(mentionTexts.length * 0.5)) ||
    score < 0.43
  )
    return null;
  const stations = mentionMatches.map(({ station, routeIndex }) => ({
    station,
    routeIndex,
  }));
  return {
    ...route,
    stations,
    physicalStations: route.stations,
    spokenStopSequence: stations,
    mentionMatches,
    anchorCoverage,
    orderConsistency: 1,
    transferCount: route.transferCount,
    pathLength: route.stations.length,
    score,
    source,
    exactAnchorCoverage,
    hardAnchorViolations: hardAnchorViolations.length,
  };
}

function deduplicateRoutes(
  routes: readonly RoutePathCandidate[],
): RoutePathCandidate[] {
  const strongest = new Map<string, RoutePathCandidate>();
  for (const route of routes) {
    const key = route.stations.map(({ station }) => station.id).join(",");
    const previous = strongest.get(key);
    if (
      !previous ||
      route.score > previous.score ||
      (route.score === previous.score && route.source === "line_fast_path")
    )
      strongest.set(key, route);
  }
  return [...strongest.values()];
}

export class StationCandidateService {
  private lexicalCache = new Map<
    string,
    ReturnType<typeof lexicalSimilarities>
  >();
  readonly scoringWork = { computations: 0, cacheHits: 0 };
  readonly similarityCache = new StationSimilarityCache();
  readonly routeWork = { alignmentComparisons: 0, graphSearches: 0 };
  private graphLoads = new Map<string, Promise<RoutePathCandidate[]>>();
  private candidatePools = new Map<
    string,
    Promise<{ surface: Station[][]; phonetic: Station[][] }>
  >();
  constructor(private readonly repository: StationRepository) {}

  async candidates(
    transcription: string,
    context: StationContext = {},
  ): Promise<StationCandidate[]> {
    return (await this.analyze(transcription, context)).candidates;
  }

  async analyze(
    transcription: string,
    context: StationContext = {},
  ): Promise<StationCandidateDiagnostics> {
    return this.analyzeInternal(transcription, null, context);
  }

  async analyzeMentions(
    mentionTexts: readonly string[],
    context: StationContext = {},
    options: SequenceSearchOptions = {},
  ): Promise<StationCandidateDiagnostics> {
    if (options.matchingStrategy)
      return this.analyzeInternal(
        mentionTexts.join("、"),
        mentionTexts,
        context,
        options,
      );
    const startedAt = Date.now();
    const strict = await this.analyzeInternal(
      mentionTexts.join("、"),
      mentionTexts,
      context,
      { ...options, matchingStrategy: "strict" },
    );
    const contained = await this.analyzeInternal(
      mentionTexts.join("、"),
      mentionTexts,
      context,
      {
        ...options,
        matchingStrategy: "contained",
        alignmentBudget: Math.max(
          0,
          STATION_SEQUENCE_LIMITS.alignmentComparisons -
            strict.metrics.alignmentComparisonCount,
        ),
      },
    );
    const quality = (result: StationCandidateDiagnostics): number[] => {
      const route = result.routeCandidates[0];
      if (!route) return [0, 0, 0, 0];
      const values = (route.mentionMatches ?? []).map(
        (m) =>
          lexicalSimilarities(
            m.mentionText,
            m.station,
            options.phoneticHints?.[m.mentionIndex],
            this.similarityCache,
          ).lexicalSimilarity,
      );
      return [
        1,
        values.filter((v) => v >= 0.25).length,
        values.reduce((a, b) => a + b, 0),
        -(route.detourRatio ?? 0) - (route.directionReversals ?? 0),
      ];
    };
    const strictQuality = quality(strict),
      containedQuality = quality(contained);
    const difference =
      strictQuality
        .map((v, i) => v - containedQuality[i]!)
        .find((v) => Math.abs(v) > 1e-9) ?? 0;
    const selected = difference < 0 ? contained : strict;
    const strategy =
      difference < 0 ? ("contained" as const) : ("strict" as const);
    const metrics = { ...selected.metrics };
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
      "alignmentComparisonCount",
      "graphSearchCount",
      "cacheHits",
      "cacheMisses",
      "sequencePreRankComparisons",
    ] as const)
      metrics[key] = (strict.metrics[key] ?? 0) + (contained.metrics[key] ?? 0);
    metrics.fallbackExecuted =
      strict.metrics.fallbackExecuted || contained.metrics.fallbackExecuted;
    metrics.totalMs = Date.now() - startedAt;
    return {
      ...selected,
      metrics,
      strategyComparison: {
        selected: strategy,
        reason:
          !strict.routeCandidates.length && !contained.routeCandidates.length
            ? "neither_matched"
            : !strict.routeCandidates.length ||
                !contained.routeCandidates.length
              ? "only_matched_strategy"
              : difference === 0
                ? "strict_tie_break"
                : "stronger_shared_lexical_evidence",
        attempts: (
          [
            ["strict", strict],
            ["contained", contained],
          ] as const
        ).map(([strategy, result]) => ({
          strategy,
          status: result.routeSearchStatus,
          score: result.routeCandidates[0]?.score ?? 0,
          fallback: result.sequenceFallbackAttempted,
          totalMs: result.metrics.totalMs,
          graphSearchCount: result.metrics.graphSearchCount,
          routeStations:
            result.routeCandidates[0]?.stations.map((s) => s.station.name) ??
            [],
        })),
      },
    };
  }

  private async analyzeInternal(
    transcription: string,
    mentionTexts: readonly string[] | null,
    context: StationContext,
    options: SequenceSearchOptions = {},
  ): Promise<StationCandidateDiagnostics> {
    const lexicalCache = this.lexicalCache;
    const cachedLexical = (
      mention: string,
      station: Station,
      hint?: string | null,
    ) => {
      const key = `${options.matchingStrategy ?? "strict"}\u0000${mention}\u0000${station.id}\u0000${hint ?? ""}`;
      let value = lexicalCache.get(key);
      if (!value) {
        this.scoringWork.computations++;
        value = lexicalSimilarities(
          mention,
          station,
          hint,
          this.similarityCache,
        );
        if (
          options.matchingStrategy === "contained" &&
          !localizedStationSimilarity(mention, station)
        ) {
          value = {
            ...value,
            nameSimilarity: this.similarityCache.similarity(
              this.similarityCache.normalize(mention, "name"),
              this.similarityCache.normalize(station.name, "name"),
              true,
            ),
          };
          value.lexicalSimilarity = Math.max(
            value.nameSimilarity,
            value.kanaSimilarity,
            value.phoneticSimilarity * 0.5,
          );
        }
        lexicalCache.set(key, value);
      } else this.scoringWork.cacheHits++;
      return value;
    };
    const totalStartedAt = Date.now();
    const initialCost = this.repository.getCostMetrics?.();
    const initialQueryCount = this.repository.getQueryCount?.() ?? 0;
    const searchText = extractStationSearchText(transcription);
    const phoneticHints = (mentionTexts ?? []).map(
      (_, index) =>
        options.phoneticHints?.[index] ??
        englishStationReading(mentionTexts?.[index] ?? "") ??
        null,
    );
    const boundStations = (mentionTexts ?? []).map(
      (mention) =>
        options.bindings?.get(stationMentionBindingKey(mention)) ?? null,
    );
    const boundNamesByMention = boundStations.map(
      (station) => station?.name ?? null,
    );
    const candidateGenerationStartedAt = Date.now();
    let surfacePools: Station[][];
    let phoneticPools: Station[][];
    if (
      mentionTexts !== null &&
      this.repository.findCandidatePools !== undefined
    ) {
      const key = [
        ...mentionTexts,
        ...phoneticHints,
        context.lineName,
        context.prefecture,
        context.previousStation,
        context.nextStation,
      ]
        .map((v) => `${v?.length ?? 0}:${v ?? ""}`)
        .join("|");
      let load = this.candidatePools.get(key);
      if (!load) {
        load = this.repository.findCandidatePools(
          mentionTexts,
          phoneticHints,
          context,
          STATION_SEQUENCE_LIMITS.surfaceCandidatesPerMention,
          STATION_SEQUENCE_LIMITS.phoneticCandidatesPerMention,
        );
        this.candidatePools.set(key, load);
      }
      const result = await load;
      surfacePools = result.surface;
      phoneticPools = result.phonetic;
    } else if (mentionTexts !== null) {
      surfacePools = await Promise.all(
        mentionTexts.map((mention) =>
          this.repository.findCandidatePool(
            extractStationSearchText(mention),
            context,
            STATION_SEQUENCE_LIMITS.surfaceCandidatesPerMention,
          ),
        ),
      );
      phoneticPools = await Promise.all(
        phoneticHints.map((phoneticHint) =>
          phoneticHint === null
            ? Promise.resolve([])
            : this.repository.findCandidatePool(
                extractStationSearchText(phoneticHint),
                context,
                STATION_SEQUENCE_LIMITS.phoneticCandidatesPerMention,
              ),
        ),
      );
    } else {
      surfacePools = [
        await this.repository.findCandidatePool(searchText, context, 100),
      ];
      phoneticPools = [];
    }
    surfacePools = surfacePools.map((stations, index) =>
      [...stations]
        .sort((left, right) => {
          const leftScore = cachedLexical(
            (mentionTexts ?? [transcription])[index] ?? "",
            left,
          );
          const rightScore = cachedLexical(
            (mentionTexts ?? [transcription])[index] ?? "",
            right,
          );
          return (
            Math.max(rightScore.nameSimilarity, rightScore.kanaSimilarity) -
            Math.max(leftScore.nameSimilarity, leftScore.kanaSimilarity)
          );
        })
        .slice(
          0,
          mentionTexts === null
            ? 100
            : STATION_SEQUENCE_LIMITS.surfaceCandidatesPerMention,
        ),
    );
    phoneticPools = phoneticPools.map((stations, index) =>
      [...stations]
        .sort(
          (left, right) =>
            stationKanaSimilarity(
              phoneticHints[index] ?? "",
              right.kana,
              this.similarityCache,
            ) -
            stationKanaSimilarity(
              phoneticHints[index] ?? "",
              left.kana,
              this.similarityCache,
            ),
        )
        .slice(0, STATION_SEQUENCE_LIMITS.phoneticCandidatesPerMention),
    );
    const perMentionPools = (mentionTexts ?? [transcription]).map((_, index) =>
      [
        ...new Map(
          [
            ...(options.supportingStations?.[index]
              ? [options.supportingStations[index]!]
              : []),
            ...(surfacePools[index] ?? []),
            ...(phoneticPools[index] ?? []),
            ...(boundStations[index] === null ||
            boundStations[index] === undefined
              ? []
              : [boundStations[index]]),
          ].map((station) => [station.id, station]),
        ).values(),
      ].slice(0, STATION_SEQUENCE_LIMITS.uniqueCandidatesPerMention),
    );
    const pools = perMentionPools;
    const pool = [
      ...new Map(
        [
          ...pools.flat(),
          ...boundStations.filter(
            (station): station is Station => station !== null,
          ),
        ].map((station) => [station.id, station]),
      ).values(),
    ];
    const candidateRowsReturned =
      (this.repository.getCostMetrics?.().rowsReturned ?? pool.length) -
      (initialCost?.rowsReturned ?? 0);
    const candidateGenerationMs = Date.now() - candidateGenerationStartedAt;
    console.info("station_search_work", {
      phase: "station candidate generation",
      scope: "job_cumulative",
      source: this.repository.getCostMetrics?.().candidateSource,
      idsRetrieved:
        this.repository.getCostMetrics?.().work?.candidateIdsRetrieved,
      prefilterChecks:
        this.repository.getCostMetrics?.().work?.candidatePrefilterChecks,
      phoneticScoringPairs:
        this.repository.getCostMetrics?.().work?.candidateSimilarityPairs,
      phoneticCacheHits:
        this.repository.getCostMetrics?.().work?.phoneticCacheHits,
    });
    const eligiblePool = pool.filter((station) =>
      isEligibleStationMention(station, transcription),
    );
    const initial = eligiblePool.map((station) =>
      scoreStation(station, transcription, context, this.similarityCache),
    );
    const hardAnchorNamesByMention = (mentionTexts ?? []).map(
      (mention, index) => {
        const boundName = boundNamesByMention[index];
        if (boundName !== null && boundName !== undefined)
          return new Set([boundName]);
        return new Set(
          (perMentionPools[index] ?? [])
            .filter((station) => {
              const similarities = lexicalSimilarities(
                mention,
                station,
                null,
                this.similarityCache,
              );
              return (
                similarities.nameSimilarity === 1 ||
                similarities.kanaSimilarity === 1
              );
            })
            .map(({ name }) => name),
        );
      },
    );
    const anchorNames =
      mentionTexts === null
        ? [
            ...new Map(
              initial
                .filter(
                  (candidate) =>
                    candidate.nameSimilarity === 1 ||
                    candidate.kanaSimilarity === 1,
                )
                .map((candidate) => [
                  candidate.station.name,
                  mentionIndex(candidate.station, transcription),
                ]),
            ),
          ]
            .filter(([, index]) => index >= 0)
            .sort((left, right) => left[1] - right[1])
            .map(([name]) => name)
            .slice(0, 12)
        : [
            ...new Set(hardAnchorNamesByMention.flatMap((names) => [...names])),
          ].slice(0, 12);
    const alignmentBudget = Math.min(
      STATION_SEQUENCE_LIMITS.alignmentComparisons,
      options.alignmentBudget ?? STATION_SEQUENCE_LIMITS.alignmentComparisons,
    );
    let alignmentComparisonCount = 0;
    const countComparison = (): void => {
      alignmentComparisonCount += 1;
      this.routeWork.alignmentComparisons++;
    };
    const lineLookupStartedAt = Date.now();
    const lineCandidateSeeds: LineCandidateSeed[] = perMentionPools.flatMap(
      (stations, mentionIndex) =>
        stations.map((station) => {
          const similarities = cachedLexical(
            mentionTexts?.[mentionIndex] ?? transcription,
            station,
            phoneticHints[mentionIndex],
          );
          return {
            stationId: station.id,
            mentionIndex,
            strength: Math.max(
              similarities.nameSimilarity,
              similarities.kanaSimilarity,
              similarities.phoneticSimilarity * 0.5,
            ),
          };
        }),
    );
    const lineRouteCandidates =
      mentionTexts !== null &&
      this.repository.findLineRouteCandidates !== undefined
        ? options.matchingStrategy === "contained" &&
          this.repository.findSequenceLineRouteCandidates
          ? await this.repository.findSequenceLineRouteCandidates(
              mentionTexts,
              phoneticHints,
              STATION_SEQUENCE_LIMITS.lineHypotheses,
            )
          : await this.repository.findLineRouteCandidates(
              lineCandidateSeeds,
              STATION_SEQUENCE_LIMITS.lineHypotheses,
            )
        : [];
    const lineLookupMs = Date.now() - lineLookupStartedAt;
    const alignmentStartedAt = Date.now();
    const alignedLineRoutes =
      mentionTexts === null
        ? []
        : lineRouteCandidates
            .map((route) =>
              alignmentComparisonCount +
                4 * (mentionTexts?.length ?? 0) * route.stations.length >
              alignmentBudget
                ? null
                : alignMentionsToRoute(
                    mentionTexts,
                    phoneticHints,
                    route,
                    "line_fast_path",
                    hardAnchorNamesByMention,
                    boundNamesByMention,
                    countComparison,
                    cachedLexical,
                    this.similarityCache,
                  ),
            )
            .filter((route): route is RoutePathCandidate => route !== null);
    let alignmentMs = Date.now() - alignmentStartedAt;
    const bestLineScore = Math.max(
      0,
      ...alignedLineRoutes.map(({ score }) => score),
    );
    const fallbackSeedStartedAt = Date.now();
    const orderedFallbackSeeds =
      mentionTexts === null
        ? anchorNames
        : mentionTexts.flatMap((mention, mentionIndex) =>
            (perMentionPools[mentionIndex] ?? [])
              .map((station) => ({
                station,
                ...lexicalSimilarities(
                  mention,
                  station,
                  phoneticHints[mentionIndex],
                  this.similarityCache,
                ),
              }))
              .filter((c) => c.lexicalSimilarity >= 0.5)
              .sort((a, b) => b.lexicalSimilarity - a.lexicalSimilarity)
              .slice(0, 1)
              .map((c) => c.station.name),
          );
    const uniqueFallbackSeeds = [...new Set(orderedFallbackSeeds)];
    // Retain both ends of long multi-line announcements while keeping four seeds.
    const fallbackSeedNames =
      uniqueFallbackSeeds.length <= STATION_SEQUENCE_LIMITS.fallbackSeeds
        ? uniqueFallbackSeeds
        : [
            ...uniqueFallbackSeeds.slice(
              0,
              STATION_SEQUENCE_LIMITS.fallbackSeeds - 1,
            ),
            uniqueFallbackSeeds.at(-1)!,
          ];
    let hypothesisGenerationMs = Date.now() - fallbackSeedStartedAt;
    const sequenceFallbackAttempted =
      mentionTexts === null
        ? anchorNames.length >= 2
        : fallbackSeedNames.length >= 2 &&
          (alignedLineRoutes.length === 0 || bestLineScore < 0.55);
    const retainedLineRoutes = sequenceFallbackAttempted
      ? alignedLineRoutes.slice(0, 2)
      : alignedLineRoutes;
    const graphRouteLimit = Math.min(
      STATION_SEQUENCE_LIMITS.fallbackRoutes,
      Math.max(
        0,
        STATION_SEQUENCE_LIMITS.routeHypotheses - retainedLineRoutes.length,
      ),
    );
    const graphSearchStartedAt = Date.now();
    let graphSearchCount = 0;
    let graphRoutes: RoutePathCandidate[] = [];
    if (sequenceFallbackAttempted && graphRouteLimit > 0) {
      const seeds = mentionTexts === null ? anchorNames : fallbackSeedNames;
      const key =
        `${graphRouteLimit}:2:` +
        seeds.map((s) => `${s.length}:${s}`).join("|");
      let load = this.graphLoads.get(key);
      if (!load) {
        graphSearchCount = 1;
        load = this.repository.findRouteCandidates(seeds, graphRouteLimit, 2);
        this.graphLoads.set(key, load);
      }
      graphRoutes = await load;
    }
    const graphSearchMs = Date.now() - graphSearchStartedAt;
    const graphAlignmentStartedAt = Date.now();
    const alignedGraphRoutes =
      mentionTexts === null
        ? graphRoutes.map((route) => ({
            ...route,
            source: "graph_fallback" as const,
          }))
        : graphRoutes
            .map((route) =>
              alignmentComparisonCount +
                4 * (mentionTexts?.length ?? 0) * route.stations.length >
              alignmentBudget
                ? null
                : alignMentionsToRoute(
                    mentionTexts,
                    phoneticHints,
                    route,
                    "graph_fallback",
                    hardAnchorNamesByMention,
                    boundNamesByMention,
                    countComparison,
                    cachedLexical,
                    this.similarityCache,
                  ),
            )
            .filter((route): route is RoutePathCandidate => route !== null);
    alignmentMs += Date.now() - graphAlignmentStartedAt;
    const routeRankingStartedAt = Date.now();
    const routeCandidates = deduplicateRoutes([
      ...retainedLineRoutes,
      ...alignedGraphRoutes,
    ])
      .sort(
        (left, right) =>
          right.score - left.score || left.transferCount - right.transferCount,
      )
      .slice(0, STATION_SEQUENCE_LIMITS.routeHypotheses);
    hypothesisGenerationMs += Date.now() - routeRankingStartedAt;
    const anchorSearchStatus =
      anchorNames.length < 2
        ? ("insufficient_anchors" as const)
        : routeCandidates.length === 0
          ? ("inconsistent_anchors" as const)
          : ("matched" as const);
    const fallbackSearchStatus = !sequenceFallbackAttempted
      ? ("not_attempted" as const)
      : alignedGraphRoutes.length > 0
        ? ("matched" as const)
        : ("no_route_match" as const);
    const routeSearchStatus: RouteSearchStatus =
      routeCandidates.length > 0
        ? "matched"
        : sequenceFallbackAttempted
          ? "no_route_match"
          : anchorSearchStatus;
    const routeById = new Map<
      number,
      {
        station: Station;
        routeCandidateIds: number[];
        bestRouteRank: number;
        bestRouteScore: number;
        routeIndex: number;
        routeOrderConsistent: boolean;
      }
    >();
    routeCandidates.forEach((route, rank) => {
      for (const item of route.stations) {
        const existing = routeById.get(item.station.id);
        if (existing === undefined) {
          routeById.set(item.station.id, {
            station: item.station,
            routeCandidateIds: [rank],
            bestRouteRank: rank,
            bestRouteScore: route.score,
            routeIndex: item.routeIndex,
            routeOrderConsistent: route.orderConsistency === 1,
          });
        } else {
          existing.routeCandidateIds.push(rank);
        }
      }
    });
    const combined = new Map(
      eligiblePool.map((station) => [station.id, station]),
    );
    for (const match of routeById.values()) {
      if (isEligibleStationMention(match.station, transcription))
        combined.set(match.station.id, match.station);
    }
    for (const station of boundStations)
      if (station !== null) combined.set(station.id, station);
    const boundStationNames = new Set(
      boundNamesByMention.filter((name): name is string => name !== null),
    );
    const candidates = [...combined.values()]
      .map((station) =>
        scoreStation(station, transcription, context, this.similarityCache),
      )
      .map((candidate): StationCandidate => {
        const route = routeById.get(candidate.station.id);
        if (route === undefined) {
          if (boundStationNames.has(candidate.station.name)) {
            return { ...candidate, score: Math.max(candidate.score, 0.9) };
          }
          const exactButRouteInconsistent =
            routeCandidates.length > 0 &&
            (candidate.nameSimilarity === 1 || candidate.kanaSimilarity === 1);
          return exactButRouteInconsistent
            ? { ...candidate, score: candidate.score * 0.6 }
            : candidate;
        }
        const routeRankFactor = Math.max(0.4, 1 - route.bestRouteRank * 0.15);
        const matchedRoute = routeCandidates[route.bestRouteRank];
        const routeFactor =
          matchedRoute?.source === "line_fast_path"
            ? 0.4
            : STATION_MATCH_WEIGHTS.exactPath;
        const routeQualityFactor =
          route.bestRouteScore >= 0.8 ? 1 : route.bestRouteScore;
        const routeContextBonus =
          routeFactor * routeRankFactor * routeQualityFactor;
        return {
          ...candidate,
          onExactPath: true,
          nearPath: false,
          routeOrderConsistent: route.routeOrderConsistent,
          routeIndex: route.routeIndex,
          previousAnchor: anchorNames[0] ?? null,
          nextAnchor: anchorNames.at(-1) ?? null,
          routeCandidateIds: route.routeCandidateIds,
          bestRouteRank: route.bestRouteRank,
          anchor: anchorNames.includes(candidate.station.name),
          routeContextBonus,
          routeSupported: true,
          score: Math.min(1, candidate.score + routeContextBonus),
        };
      })
      .filter((candidate) => candidate.score >= 0.35 || candidate.onExactPath)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.station.name.localeCompare(right.station.name, "ja"),
      )
      .filter(
        (candidate, index, ranked) =>
          ranked.findIndex(
            (item) => item.station.name === candidate.station.name,
          ) === index,
      )
      .slice(0, 24);
    const mentionCandidates: MentionStationCandidate[][] = (
      mentionTexts ?? []
    ).map((mentionText, mentionIndex) => {
      const routeMatches = routeCandidates.flatMap((route, routeHypothesisId) =>
        (route.mentionMatches ?? [])
          .filter((match) => match.mentionIndex === mentionIndex)
          .map((match) => ({ route, routeHypothesisId, match })),
      );
      const stations = new Map(
        (perMentionPools[mentionIndex] ?? []).map((station) => [
          station.id,
          station,
        ]),
      );
      const rescueEligibility = new Map<number, boolean>();
      for (const { route, match } of routeMatches) {
        if (stations.has(match.station.id)) continue;
        const previous = route.mentionMatches?.find(
          (m) => m.mentionIndex === mentionIndex - 1,
        );
        const next = route.mentionMatches?.find(
          (m) => m.mentionIndex === mentionIndex + 1,
        );
        const lexical = Math.max(match.nameSimilarity, match.kanaSimilarity);
        const anchoredInterval =
          previous &&
          next &&
          Math.max(previous.nameSimilarity, previous.kanaSimilarity) >= 0.85 &&
          Math.max(next.nameSimilarity, next.kanaSimilarity) >= 0.85 &&
          previous.routeIndex < match.routeIndex &&
          match.routeIndex < next.routeIndex &&
          next.routeIndex - previous.routeIndex <= 4;
        const competitors = anchoredInterval
          ? (route.physicalStations ?? route.stations)
              .filter(
                (s) =>
                  s.routeIndex > previous.routeIndex &&
                  s.routeIndex < next.routeIndex,
              )
              .filter(
                (s) =>
                  cachedLexical(
                    mentionText,
                    s.station,
                    phoneticHints[mentionIndex],
                  ).lexicalSimilarity >=
                  lexical - 0.15,
              )
          : [];
        const eligible = Boolean(
          anchoredInterval &&
          competitors.length === 1 &&
          lexical >= 0.5 &&
          route.score >= 0.8 &&
          route.orderConsistency === 1 &&
          (route.hardAnchorViolations ?? 0) === 0,
        );
        rescueEligibility.set(match.station.id, eligible || lexical >= 0.85);
        // Keep route alternatives as model material; hard binding eligibility remains conservative.
        stations.set(match.station.id, match.station);
      }
      return [...stations.values()]
        .map((station): MentionStationCandidate => {
          const {
            nameSimilarity,
            kanaSimilarity,
            phoneticSimilarity,
            lexicalSimilarity,
          } = lexicalSimilarities(
            mentionText,
            station,
            phoneticHints[mentionIndex],
            this.similarityCache,
          );
          const bound = boundNamesByMention[mentionIndex] === station.name;
          const supportingRoutes = routeMatches.filter(
            ({ match }) => match.station.id === station.id,
          );
          const bestRouteScore = supportingRoutes.reduce<number | null>(
            (best, { route }) =>
              best === null || route.score > best ? route.score : best,
            null,
          );
          const conflictsWithMatchedRoute =
            !bound &&
            routeCandidates.length > 0 &&
            supportingRoutes.length === 0;
          const hardMatch =
            bound ||
            nameSimilarity === 1 ||
            kanaSimilarity === 1 ||
            Math.max(nameSimilarity, kanaSimilarity) >= 0.85;
          const lexicalBase = Math.min(
            0.85,
            nameSimilarity * 0.35 +
              kanaSimilarity * 0.35 +
              phoneticSimilarity * 0.15,
          );
          const evidenceScore =
            lexicalBase * (conflictsWithMatchedRoute ? 0.25 : 1) +
            (bestRouteScore ?? 0) * 0.4;
          const finalScore = bound
            ? Math.max(0.95, evidenceScore)
            : Math.min(1, evidenceScore);
          return {
            mentionIndex,
            mentionText,
            station,
            nameSimilarity,
            kanaSimilarity,
            phoneticSimilarity,
            bound,
            correctionEligible: rescueEligibility.get(station.id) ?? true,
            lexicalScore: lexicalSimilarity,
            matchStrength: hardMatch ? "hard" : "soft",
            routeHypothesisIds: supportingRoutes.map(
              ({ routeHypothesisId }) => routeHypothesisId,
            ),
            bestRouteScore,
            finalScore,
          };
        })
        .filter(
          (candidate) =>
            candidate.lexicalScore >= 0.2 || candidate.bestRouteScore !== null,
        )
        .sort(
          (left, right) =>
            right.finalScore - left.finalScore ||
            right.lexicalScore - left.lexicalScore,
        )
        .slice(0, STATION_SEQUENCE_LIMITS.uniqueCandidatesPerMention);
    });
    const totalMs = Date.now() - totalStartedAt;
    const metrics: StationSequenceMetrics = {
      mentions: mentionTexts?.length ?? 0,
      candidateRowsReturned,
      ...(this.repository.getCostMetrics?.().d1RowsRead === undefined
        ? {}
        : {
            d1RowsRead:
              (this.repository.getCostMetrics?.().d1RowsRead ?? 0) -
              (initialCost?.d1RowsRead ?? 0),
          }),
      cacheHits:
        (this.repository.getCostMetrics?.().cacheHits ?? 0) -
        (initialCost?.cacheHits ?? 0),
      cacheMisses:
        (this.repository.getCostMetrics?.().cacheMisses ?? 0) -
        (initialCost?.cacheMisses ?? 0),
      surfaceCandidateCount: surfacePools.reduce(
        (sum, values) => sum + values.length,
        0,
      ),
      phoneticCandidateCount: phoneticPools.reduce(
        (sum, values) => sum + values.length,
        0,
      ),
      uniqueCandidateCount: perMentionPools.reduce(
        (sum, values) => sum + values.length,
        0,
      ),
      lineIdsLoaded: Math.ceil(lineRouteCandidates.length / 2),
      routeHypothesesGenerated: lineRouteCandidates.length + graphRoutes.length,
      routeHypothesesKept: routeCandidates.length,
      graphSearchCount,
      fallbackExecuted: sequenceFallbackAttempted,
      fallbackSeedCount: sequenceFallbackAttempted
        ? fallbackSeedNames.length
        : 0,
      alignmentRouteCount: lineRouteCandidates.length + graphRoutes.length,
      alignmentComparisonCount,
      d1QueryCount: Math.max(
        0,
        (this.repository.getQueryCount?.() ?? initialQueryCount) -
          initialQueryCount,
      ),
      sequencePreRankComparisons:
        (this.repository.getCostMetrics?.().sequencePreRankComparisons ?? 0) -
        (initialCost?.sequencePreRankComparisons ?? 0),
      candidateGenerationMs,
      lineLookupMs,
      lineRouteLoadingMs:
        (this.repository.getCostMetrics?.().lineRouteLoadingMs ?? 0) -
        (initialCost?.lineRouteLoadingMs ?? 0),
      hypothesisGenerationMs,
      graphSearchMs,
      alignmentMs,
      reconciliationMs: 0,
      totalMs,
    };
    this.routeWork.graphSearches += graphSearchCount;
    console.info("station_search_work", {
      phase: "station candidate scoring",
      scope: "job_cumulative",
      ...this.scoringWork,
      editDistanceCalls: this.similarityCache.work.editDistanceCalls,
      editDistanceCells: this.similarityCache.work.editDistanceCells,
      normalizationComputations:
        this.similarityCache.work.normalizationComputations,
      normalizationCacheHits: this.similarityCache.work.normalizationCacheHits,
      similarityCacheHits: this.similarityCache.work.similarityCacheHits,
      repositoryEditDistanceCells:
        this.repository.getCostMetrics?.().work?.editDistanceCells,
    });
    console.info("station_search_work", {
      phase: "route resolution / path search",
      scope: "job_cumulative",
      ...this.routeWork,
      graphStatesExpanded:
        this.repository.getCostMetrics?.().work?.graphStatesExpanded,
      routeLexicalPairs:
        this.repository.getCostMetrics?.().work?.routeLexicalPairs,
      routeSimilarityCacheHits:
        this.repository.getCostMetrics?.().work?.routeSimilarityCacheHits,
      sequencePreRankComparisons:
        this.repository.getCostMetrics?.().sequencePreRankComparisons,
    });
    return {
      searchText,
      context,
      pool,
      eligiblePool,
      anchorNames,
      anchorSearchStatus,
      routeSearchStatus,
      sequenceFallbackAttempted,
      fallbackSearchStatus,
      mentionCandidates,
      routeCandidates,
      candidates,
      metrics,
    };
  }
}

export const createReconciliationWork = () => ({
  occurrenceLists: 0,
  candidatesExamined: 0,
  routeMatchesExamined: 0,
});
export function reconcileStationMentionCandidates(
  sequenceDiagnostics: readonly StationCandidateDiagnostics[],
  work = createReconciliationWork(),
  similarityCache = new StationSimilarityCache(),
): Map<string, Station> {
  const startedAt = Date.now();
  const occurrences = new Map<string, MentionStationCandidate[][]>();
  for (const diagnostics of sequenceDiagnostics) {
    for (const candidates of diagnostics.mentionCandidates) {
      work.occurrenceLists++;
      const rawMention = candidates[0]?.mentionText;
      if (rawMention === undefined) continue;
      const key = similarityCache.normalize(rawMention, "name");
      const values = occurrences.get(key) ?? [];
      values.push(candidates);
      occurrences.set(key, values);
    }
  }
  const bindings = new Map<string, Station>();
  for (const [key, candidateLists] of occurrences) {
    if (candidateLists.length === 1) {
      const candidates = candidateLists[0]!;
      const winner = candidates[0];
      const runner = candidates.find((c) => {
        work.candidatesExamined++;
        return c.station.name !== winner?.station.name;
      });
      const strongRoute = sequenceDiagnostics.some(
        (d) =>
          d.routeCandidates.length <= 2 &&
          d.routeCandidates.some(
            (r) =>
              r.score >= 0.85 &&
              r.orderConsistency === 1 &&
              (r.hardAnchorViolations ?? 0) === 0 &&
              r.mentionMatches?.some((m) => {
                work.routeMatchesExamined++;
                return (
                  m.mentionText === winner?.mentionText &&
                  m.station.id === winner.station.id
                );
              }),
          ),
      );
      if (
        winner &&
        winner.correctionEligible !== false &&
        strongRoute &&
        (winner.bestRouteScore ?? 0) >= 0.85 &&
        Math.max(winner.nameSimilarity, winner.kanaSimilarity) >= 0.5 &&
        winner.finalScore >= 0.65 &&
        winner.finalScore - (runner?.finalScore ?? 0) >= 0.18
      ) {
        winner.bound = true;
        winner.matchStrength = "hard";
        bindings.set(key, winner.station);
      }
      continue;
    }
    const evidenceByStation = new Map<
      string,
      { station: Station; score: number; support: number }
    >();
    for (const candidates of candidateLists) {
      for (const candidate of candidates.slice(0, 3)) {
        work.candidatesExamined++;
        const routeEvidence =
          candidate.bestRouteScore !== null &&
          candidate.bestRouteScore >= 0.55 &&
          Math.max(candidate.nameSimilarity, candidate.kanaSimilarity) >= 0.35;
        const surfaceEvidence =
          Math.max(candidate.nameSimilarity, candidate.kanaSimilarity) >= 0.85;
        if (!routeEvidence && !surfaceEvidence) continue;
        const evidence =
          candidate.finalScore +
          (candidate.bestRouteScore ?? 0) * 0.1 +
          Math.max(candidate.nameSimilarity, candidate.kanaSimilarity) * 0.1;
        const existing = evidenceByStation.get(candidate.station.name);
        if (existing === undefined) {
          evidenceByStation.set(candidate.station.name, {
            station: candidate.station,
            score: evidence,
            support: 1,
          });
        } else {
          existing.score = Math.max(existing.score, evidence);
          existing.support += 1;
        }
      }
    }
    const ranked = [...evidenceByStation.values()]
      .map((value) => ({
        ...value,
        score: value.score + Math.min(0.1, (value.support - 1) * 0.05),
      }))
      .sort((left, right) => right.score - left.score);
    const winner = ranked[0];
    if (
      winner === undefined ||
      winner.score < 0.55 ||
      winner.score - (ranked[1]?.score ?? 0) < 0.04
    )
      continue;
    bindings.set(key, winner.station);
    const global = candidateLists.flat().find((c) => {
      work.candidatesExamined++;
      return c.station.name === winner.station.name;
    });
    for (const candidates of candidateLists) {
      const mentionIndex = candidates[0]?.mentionIndex ?? 0;
      const mentionText = candidates[0]?.mentionText ?? key;
      const local = candidates.find(({ station }) => {
        work.candidatesExamined++;
        return station.name === winner.station.name;
      });
      const similarity = lexicalSimilarities(
        mentionText,
        winner.station,
        null,
        similarityCache,
      );
      const localContradiction = candidates.some((c) => {
        work.candidatesExamined++;
        return (
          c.station.name !== winner.station.name &&
          (c.bestRouteScore ?? 0) >= 0.8 &&
          Math.max(c.nameSimilarity, c.kanaSimilarity) >= 0.85
        );
      });
      if (
        localContradiction ||
        Math.max(similarity.nameSimilarity, similarity.kanaSimilarity) < 0.35
      )
        continue;
      const template =
        local ??
        (global
          ? { ...global, ...similarity, correctionEligible: true }
          : undefined);
      if (template === undefined) continue;
      const reconciled: MentionStationCandidate = {
        ...template,
        mentionIndex,
        mentionText,
        bound: true,
        matchStrength: "hard",
        finalScore: Math.max(0.95, template.finalScore),
      };
      const remaining = candidates
        .filter(({ station }) => {
          work.candidatesExamined++;
          return station.name !== winner.station.name;
        })
        .map((candidate) => ({ ...candidate, bound: false }));
      candidates.splice(0, candidates.length, reconciled, ...remaining);
    }
  }
  const reconciliationMs = Date.now() - startedAt;
  for (const diagnostics of sequenceDiagnostics) {
    diagnostics.metrics.reconciliationMs = reconciliationMs;
    diagnostics.metrics.totalMs += reconciliationMs;
  }
  return bindings;
}
