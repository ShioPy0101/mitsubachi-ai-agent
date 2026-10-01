import { extractStationSearchText, normalizeKana, normalizeStationName } from "./normalization";
import { stationKanaSimilarity, stationNameSimilarity } from "./similarity";
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
import type { SequenceRole } from "../metadata/service";

export interface StationRepository {
  getQueryCount?(): number;
  findCandidatePool(searchText: string, context: StationContext, limit: number): Promise<Station[]>;
  findCandidatePools?(
    surfaceTexts: readonly string[],
    phoneticHints: readonly (string | null)[],
    context: StationContext,
    surfaceLimit: number,
    phoneticLimit: number,
  ): Promise<{ surface: Station[][]; phonetic: Station[][] }>;
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
} as const;

export type SequenceSearchOptions = {
  sequenceRole?: SequenceRole;
  destinationContext?: boolean;
  phoneticHints?: readonly (string | null)[];
  bindings?: ReadonlyMap<string, Station>;
};

export type StationCandidateDiagnostics = {
  searchText: string;
  context: StationContext;
  pool: Station[];
  eligiblePool: Station[];
  anchorNames: string[];
  anchorSearchStatus: "matched" | "insufficient_anchors" | "inconsistent_anchors";
  routeSearchStatus: RouteSearchStatus;
  sequenceFallbackAttempted: boolean;
  fallbackSearchStatus: "not_attempted" | "matched" | "no_route_match";
  mentionCandidates: MentionStationCandidate[][];
  routeCandidates: RoutePathCandidate[];
  candidates: StationCandidate[];
  metrics: StationSequenceMetrics;
};

export type StationSequenceMetrics = {
  mentions: number;
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
  candidateGenerationMs: number;
  lineLookupMs: number;
  hypothesisGenerationMs: number;
  graphSearchMs: number;
  alignmentMs: number;
  reconciliationMs: number;
  totalMs: number;
};

function adjacencyScore(station: Station, context: StationContext): number {
  const previous = context.previousStation;
  const next = context.nextStation;
  const previousMatches = previous != null && (station.prevStation === previous || station.nextStation === previous);
  const nextMatches = next != null && (station.prevStation === next || station.nextStation === next);
  return previousMatches || nextMatches ? 1 : 0;
}

function isEligibleStationMention(station: Station, transcription: string): boolean {
  if (Array.from(station.name).length > 1) return true;
  const escapedName = station.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const normalized = transcription.normalize("NFKC");
  if (normalized.includes(`${station.name}駅`)) return true;
  return new RegExp(
    `(?:次は|つぎは|まもなく|こちらは)[\\s、,「『]*${escapedName}(?:です|でございます|に到着|[、。,.!?！？」』])`,
    "u",
  ).test(normalized);
}

export function scoreStation(station: Station, transcription: string, context: StationContext): StationCandidate {
  const nameSimilarity = stationNameSimilarity(transcription, station.name);
  const kanaSimilarity = stationKanaSimilarity(transcription, station.kana);
  const lineBonus = context.lineName != null && station.lineName === context.lineName ? 1 : 0;
  const prefectureBonus = context.prefecture != null && station.prefecture === context.prefecture ? 1 : 0;
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
  const nameIndex = normalizeStationName(transcription).indexOf(normalizeStationName(station.name));
  const kanaIndex = station.kana === null ? -1 : normalizeKana(transcription).indexOf(normalizeKana(station.kana));
  if (nameIndex < 0) return kanaIndex;
  if (kanaIndex < 0) return nameIndex;
  return Math.min(nameIndex, kanaIndex);
}

function lexicalSimilarities(mention: string, station: Station, inferredReading?: string | null): {
  nameSimilarity: number;
  kanaSimilarity: number;
  phoneticSimilarity: number;
  lexicalSimilarity: number;
} {
  const nameSimilarity = stationNameSimilarity(mention, station.name);
  const kanaSimilarity = stationKanaSimilarity(mention, station.kana);
  const phoneticSimilarity = inferredReading == null ? 0 : stationKanaSimilarity(inferredReading, station.kana);
  return {
    nameSimilarity,
    kanaSimilarity,
    phoneticSimilarity,
    // An inferred reading can rescue a candidate, but cannot become as strong as
    // direct surface or kana evidence by itself.
    lexicalSimilarity: Math.max(nameSimilarity, kanaSimilarity, phoneticSimilarity * 0.5),
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
  maximumStationGap = 4,
  onComparison?: () => void,
): RoutePathCandidate | null {
  if (mentionTexts.length < 2 || route.stations.length < mentionTexts.length) return null;
  const effectiveMaximumStationGap = Math.min(
    16,
    Math.max(maximumStationGap, Math.ceil(route.stations.length / mentionTexts.length) * 2),
  );
  const alignmentValue = (mentionIndex: number, station: Station): number => {
    onComparison?.();
    const similarities = lexicalSimilarities(
      mentionTexts[mentionIndex] ?? "",
      station,
      phoneticHints[mentionIndex],
    );
    const lexical = similarities.nameSimilarity * 0.75
      + similarities.kanaSimilarity * 0.35
      + similarities.phoneticSimilarity * 0.15;
    const hardNames = hardAnchorNamesByMention[mentionIndex] ?? new Set<string>();
    const boundName = boundNamesByMention[mentionIndex];
    if (boundName !== null && boundName !== undefined) return station.name === boundName ? lexical + 1 : lexical - 2;
    if (hardNames.size === 0) return lexical;
    return lexical + (hardNames.has(station.name) ? 0.5 : -0.35);
  };
  type Alignment = { value: number; indexes: number[] };
  let previous = route.stations.map((item, routeIndex): Alignment => {
    return { value: alignmentValue(0, item.station), indexes: [routeIndex] };
  });
  for (let mentionIndex = 1; mentionIndex < mentionTexts.length; mentionIndex += 1) {
    const current = route.stations.map((item, routeIndex): Alignment => {
      let best: Alignment | null = null;
      for (
        let previousIndex = Math.max(0, routeIndex - effectiveMaximumStationGap);
        previousIndex < routeIndex;
        previousIndex += 1
      ) {
        const prior = previous[previousIndex];
        if (prior === undefined) continue;
        const gap = routeIndex - previousIndex;
        const value = prior.value + alignmentValue(mentionIndex, item.station) + 0.2 - (gap - 1) * 0.04;
        if (best === null || value > best.value) best = { value, indexes: [...prior.indexes, routeIndex] };
      }
      return best ?? { value: Number.NEGATIVE_INFINITY, indexes: [] };
    });
    previous = current;
  }
  const best = previous.reduce<Alignment | null>(
    (selected, item) => selected === null || item.value > selected.value ? item : selected,
    null,
  );
  if (best === null || best.indexes.length !== mentionTexts.length) return null;
  const mentionMatches: MentionRouteMatch[] = best.indexes.map((routeIndex, mentionIndex) => {
    const station = route.stations[routeIndex]!.station;
    return {
      mentionIndex,
      mentionText: mentionTexts[mentionIndex] ?? "",
      station,
      routeIndex,
      ...lexicalSimilarities(mentionTexts[mentionIndex] ?? "", station, phoneticHints[mentionIndex]),
    };
  });
  if (mentionMatches.some((match) => {
    const boundName = boundNamesByMention[match.mentionIndex];
    return boundName !== null && boundName !== undefined && match.station.name !== boundName;
  })) return null;
  const lexicalValues = mentionMatches.map(({ lexicalSimilarity }) => lexicalSimilarity);
  const hardAnchorMatches = mentionMatches.filter((match) => {
    const hardNames = hardAnchorNamesByMention[match.mentionIndex] ?? new Set<string>();
    return hardNames.size > 0 && hardNames.has(match.station.name);
  }).length;
  const hardAnchorViolations = mentionMatches.filter((match) => {
    const hardNames = hardAnchorNamesByMention[match.mentionIndex] ?? new Set<string>();
    return hardNames.size > 0 && !hardNames.has(match.station.name);
  });
  const hardAnchorCount = hardAnchorNamesByMention.filter((names) => names.size > 0).length;
  const exactAnchorCoverage = hardAnchorCount === 0 ? 1 : hardAnchorMatches / hardAnchorCount;
  const hardAnchorViolationRatio = hardAnchorCount === 0 ? 0 : hardAnchorViolations.length / hardAnchorCount;
  // A coherent route that already explains most hard anchors must not discard
  // another hard station with a zero-similarity replacement. When several exact
  // ASR matches contradict one another (for example accidental real station
  // names), retain the existing sequence-level route comparison instead.
  const coherentHardEvidence = hardAnchorCount === 1 || exactAnchorCoverage >= 0.6;
  if (coherentHardEvidence
    && hardAnchorViolations.some(({ lexicalSimilarity }) => lexicalSimilarity === 0)) return null;
  const covered = lexicalValues.filter((value) => value >= 0.25).length;
  const strong = lexicalValues.filter((value) => value >= 0.65).length;
  const gaps = best.indexes.slice(1).map((value, index) => value - (best.indexes[index] ?? value));
  const continuity = gaps.length === 0
    ? 0
    : gaps.reduce((sum, gap) => sum + Math.max(0, 1 - (gap - 1) * 0.25), 0) / gaps.length;
  const meanLexical = lexicalValues.reduce((sum, value) => sum + value, 0) / lexicalValues.length;
  const anchorCoverage = covered / mentionTexts.length;
  const score = Math.max(0, Math.min(1,
    meanLexical * 0.4
      + anchorCoverage * 0.25
      + continuity * 0.2
      + (strong / mentionTexts.length) * 0.15
      + (hardAnchorCount === 0 ? 0 : exactAnchorCoverage * 0.15)
      - hardAnchorViolationRatio * 0.05
      - route.transferCount * 0.08,
  ));
  if (covered < Math.max(2, Math.ceil(mentionTexts.length * 0.5)) || score < 0.43) return null;
  const stations = mentionMatches.map(({ station }, routeIndex) => ({ station, routeIndex }));
  return {
    stations,
    mentionMatches: mentionMatches.map((match, routeIndex) => ({ ...match, routeIndex })),
    anchorCoverage,
    orderConsistency: 1,
    transferCount: route.transferCount,
    pathLength: stations.length,
    score,
    source,
    exactAnchorCoverage,
    hardAnchorViolations: hardAnchorViolations.length,
  };
}

function deduplicateRoutes(routes: readonly RoutePathCandidate[]): RoutePathCandidate[] {
  return [...new Map(routes.map((route) => [
    route.stations.map(({ station }) => station.id).join(","),
    route,
  ])).values()];
}

export class StationCandidateService {
  constructor(private readonly repository: StationRepository) {}

  async candidates(transcription: string, context: StationContext = {}): Promise<StationCandidate[]> {
    return (await this.analyze(transcription, context)).candidates;
  }

  async analyze(transcription: string, context: StationContext = {}): Promise<StationCandidateDiagnostics> {
    return this.analyzeInternal(transcription, null, context);
  }

  async analyzeMentions(
    mentionTexts: readonly string[],
    context: StationContext = {},
    options: SequenceSearchOptions = {},
  ): Promise<StationCandidateDiagnostics> {
    return this.analyzeInternal(mentionTexts.join("、"), mentionTexts, context, options);
  }

  private async analyzeInternal(
    transcription: string,
    mentionTexts: readonly string[] | null,
    context: StationContext,
    options: SequenceSearchOptions = {},
  ): Promise<StationCandidateDiagnostics> {
    const totalStartedAt = Date.now();
    const initialQueryCount = this.repository.getQueryCount?.() ?? 0;
    const searchText = extractStationSearchText(transcription);
    const phoneticHints = (mentionTexts ?? []).map((_, index) => options.phoneticHints?.[index] ?? null);
    const boundStations = (mentionTexts ?? []).map((mention) =>
      options.bindings?.get(stationMentionBindingKey(mention)) ?? null);
    const boundNamesByMention = boundStations.map((station) => station?.name ?? null);
    const candidateGenerationStartedAt = Date.now();
    let surfacePools: Station[][];
    let phoneticPools: Station[][];
    if (mentionTexts !== null && this.repository.findCandidatePools !== undefined) {
      const result = await this.repository.findCandidatePools(
        mentionTexts,
        phoneticHints,
        context,
        STATION_SEQUENCE_LIMITS.surfaceCandidatesPerMention,
        STATION_SEQUENCE_LIMITS.phoneticCandidatesPerMention,
      );
      surfacePools = result.surface;
      phoneticPools = result.phonetic;
    } else if (mentionTexts !== null) {
      surfacePools = await Promise.all(mentionTexts.map((mention) =>
        this.repository.findCandidatePool(
          extractStationSearchText(mention),
          context,
          STATION_SEQUENCE_LIMITS.surfaceCandidatesPerMention,
        )));
      phoneticPools = await Promise.all(phoneticHints.map((phoneticHint) => phoneticHint === null
        ? Promise.resolve([])
        : this.repository.findCandidatePool(
          extractStationSearchText(phoneticHint),
          context,
          STATION_SEQUENCE_LIMITS.phoneticCandidatesPerMention,
        )));
    } else {
      surfacePools = [await this.repository.findCandidatePool(searchText, context, 100)];
      phoneticPools = [];
    }
    surfacePools = surfacePools.map((stations, index) => [...stations]
      .sort((left, right) => {
        const leftScore = lexicalSimilarities((mentionTexts ?? [transcription])[index] ?? "", left);
        const rightScore = lexicalSimilarities((mentionTexts ?? [transcription])[index] ?? "", right);
        return Math.max(rightScore.nameSimilarity, rightScore.kanaSimilarity)
          - Math.max(leftScore.nameSimilarity, leftScore.kanaSimilarity);
      })
      .slice(0, mentionTexts === null ? 100 : STATION_SEQUENCE_LIMITS.surfaceCandidatesPerMention));
    phoneticPools = phoneticPools.map((stations, index) => [...stations]
      .sort((left, right) => stationKanaSimilarity(phoneticHints[index] ?? "", right.kana)
        - stationKanaSimilarity(phoneticHints[index] ?? "", left.kana))
      .slice(0, STATION_SEQUENCE_LIMITS.phoneticCandidatesPerMention));
    const perMentionPools = (mentionTexts ?? [transcription]).map((_, index) => [...new Map([
      ...(surfacePools[index] ?? []),
      ...(phoneticPools[index] ?? []),
      ...(boundStations[index] === null || boundStations[index] === undefined ? [] : [boundStations[index]]),
    ].map((station) => [station.id, station])).values()]
      .slice(0, STATION_SEQUENCE_LIMITS.uniqueCandidatesPerMention));
    const pools = perMentionPools;
    const pool = [...new Map([
      ...pools.flat(),
      ...boundStations.filter((station): station is Station => station !== null),
    ].map((station) => [station.id, station])).values()];
    const candidateGenerationMs = Date.now() - candidateGenerationStartedAt;
    const eligiblePool = pool.filter((station) => isEligibleStationMention(station, transcription));
    const initial = eligiblePool
      .map((station) => scoreStation(station, transcription, context));
    const hardAnchorNamesByMention = (mentionTexts ?? []).map((mention, index) => {
      const boundName = boundNamesByMention[index];
      if (boundName !== null && boundName !== undefined) return new Set([boundName]);
      return new Set((perMentionPools[index] ?? [])
        .filter((station) => {
          const similarities = lexicalSimilarities(mention, station);
          return similarities.nameSimilarity === 1 || similarities.kanaSimilarity === 1;
        })
        .map(({ name }) => name));
    });
    const anchorNames = mentionTexts === null
      ? [...new Map(
        initial
          .filter((candidate) => candidate.nameSimilarity === 1 || candidate.kanaSimilarity === 1)
          .map((candidate) => [candidate.station.name, mentionIndex(candidate.station, transcription)]),
      )]
        .filter(([, index]) => index >= 0)
        .sort((left, right) => left[1] - right[1])
        .map(([name]) => name)
        .slice(0, 12)
      : [...new Set(hardAnchorNamesByMention.flatMap((names) => [...names]))].slice(0, 12);
    let alignmentComparisonCount = 0;
    const countComparison = (): void => { alignmentComparisonCount += 1; };
    const maximumStationGap = options.sequenceRole === "direction" ? 16 : 4;
    const lineLookupStartedAt = Date.now();
    const lineCandidateSeeds: LineCandidateSeed[] = perMentionPools.flatMap((stations, mentionIndex) =>
      stations.map((station) => {
        const similarities = lexicalSimilarities(
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
      }));
    const lineRouteCandidates = mentionTexts !== null && this.repository.findLineRouteCandidates !== undefined
      ? await this.repository.findLineRouteCandidates(
        lineCandidateSeeds,
        STATION_SEQUENCE_LIMITS.lineHypotheses,
      )
      : [];
    const lineLookupMs = Date.now() - lineLookupStartedAt;
    const alignmentStartedAt = Date.now();
    const alignedLineRoutes = mentionTexts === null
      ? []
      : lineRouteCandidates
        .map((route) => alignMentionsToRoute(
          mentionTexts,
          phoneticHints,
          route,
          "line_fast_path",
          hardAnchorNamesByMention,
          boundNamesByMention,
          maximumStationGap,
          countComparison,
        ))
        .filter((route): route is RoutePathCandidate => route !== null);
    let alignmentMs = Date.now() - alignmentStartedAt;
    const bestLineScore = Math.max(0, ...alignedLineRoutes.map(({ score }) => score));
    const fallbackSeedStartedAt = Date.now();
    const fallbackSeedNames = [...new Set([
      ...anchorNames,
      ...(mentionTexts ?? []).flatMap((mention, mentionIndex) => (perMentionPools[mentionIndex] ?? [])
        .map((station) => ({ station, ...lexicalSimilarities(mention, station, phoneticHints[mentionIndex]) }))
        .filter(({ lexicalSimilarity }) => lexicalSimilarity >= 0.5)
        .sort((left, right) => right.lexicalSimilarity - left.lexicalSimilarity)
        .slice(0, 1)
        .map(({ station }) => station.name)),
    ])].slice(0, STATION_SEQUENCE_LIMITS.fallbackSeeds);
    let hypothesisGenerationMs = Date.now() - fallbackSeedStartedAt;
    const sequenceFallbackAttempted = mentionTexts === null
      ? anchorNames.length >= 2
      : fallbackSeedNames.length >= 2
        && (alignedLineRoutes.length === 0 || bestLineScore < 0.55);
    const retainedLineRoutes = sequenceFallbackAttempted
      ? alignedLineRoutes.slice(0, 2)
      : alignedLineRoutes;
    const graphRouteLimit = Math.min(
      STATION_SEQUENCE_LIMITS.fallbackRoutes,
      Math.max(0, STATION_SEQUENCE_LIMITS.routeHypotheses - retainedLineRoutes.length),
    );
    const graphSearchStartedAt = Date.now();
    const graphRoutes = sequenceFallbackAttempted && graphRouteLimit > 0
      ? await this.repository.findRouteCandidates(
        mentionTexts === null ? anchorNames : fallbackSeedNames,
        graphRouteLimit,
        2,
      )
      : [];
    const graphSearchMs = Date.now() - graphSearchStartedAt;
    const graphAlignmentStartedAt = Date.now();
    const alignedGraphRoutes = mentionTexts === null
      ? graphRoutes.map((route) => ({ ...route, source: "graph_fallback" as const }))
      : graphRoutes
        .map((route) => alignMentionsToRoute(
          mentionTexts,
          phoneticHints,
          route,
          "graph_fallback",
          hardAnchorNamesByMention,
          boundNamesByMention,
          maximumStationGap,
          countComparison,
        ))
        .filter((route): route is RoutePathCandidate => route !== null);
    alignmentMs += Date.now() - graphAlignmentStartedAt;
    const routeRankingStartedAt = Date.now();
    const routeCandidates = deduplicateRoutes([...retainedLineRoutes, ...alignedGraphRoutes])
      .sort((left, right) => right.score - left.score || left.transferCount - right.transferCount)
      .slice(0, STATION_SEQUENCE_LIMITS.routeHypotheses);
    hypothesisGenerationMs += Date.now() - routeRankingStartedAt;
    const anchorSearchStatus = anchorNames.length < 2
      ? "insufficient_anchors" as const
      : routeCandidates.length === 0
        ? "inconsistent_anchors" as const
        : "matched" as const;
    const fallbackSearchStatus = !sequenceFallbackAttempted
      ? "not_attempted" as const
      : alignedGraphRoutes.length > 0
        ? "matched" as const
        : "no_route_match" as const;
    const routeSearchStatus: RouteSearchStatus = routeCandidates.length > 0
      ? "matched"
      : sequenceFallbackAttempted
        ? "no_route_match"
        : anchorSearchStatus;
    const routeById = new Map<number, {
      station: Station;
      routeCandidateIds: number[];
      bestRouteRank: number;
      bestRouteScore: number;
      routeIndex: number;
      routeOrderConsistent: boolean;
    }>();
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
    const combined = new Map(eligiblePool.map((station) => [station.id, station]));
    for (const match of routeById.values()) {
      if (isEligibleStationMention(match.station, transcription)) combined.set(match.station.id, match.station);
    }
    for (const station of boundStations) if (station !== null) combined.set(station.id, station);
    const boundStationNames = new Set(boundNamesByMention.filter((name): name is string => name !== null));
    const candidates = [...combined.values()]
      .map((station) => scoreStation(station, transcription, context))
      .map((candidate): StationCandidate => {
        const route = routeById.get(candidate.station.id);
        if (route === undefined) {
          if (boundStationNames.has(candidate.station.name)) {
            return { ...candidate, score: Math.max(candidate.score, 0.9) };
          }
          const exactButRouteInconsistent = routeCandidates.length > 0
            && (candidate.nameSimilarity === 1 || candidate.kanaSimilarity === 1);
          return exactButRouteInconsistent ? { ...candidate, score: candidate.score * 0.6 } : candidate;
        }
        const routeRankFactor = Math.max(0.4, 1 - route.bestRouteRank * 0.15);
        const matchedRoute = routeCandidates[route.bestRouteRank];
        const routeFactor = matchedRoute?.source === "line_fast_path" ? 0.4 : STATION_MATCH_WEIGHTS.exactPath;
        const routeQualityFactor = route.bestRouteScore >= 0.8 ? 1 : route.bestRouteScore;
        const routeContextBonus = routeFactor * routeRankFactor * routeQualityFactor;
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
      .sort((left, right) => right.score - left.score || left.station.name.localeCompare(right.station.name, "ja"))
      .filter((candidate, index, ranked) =>
        ranked.findIndex((item) => item.station.name === candidate.station.name) === index)
      .slice(0, 24);
    const mentionCandidates: MentionStationCandidate[][] = (mentionTexts ?? []).map((mentionText, mentionIndex) => {
      const routeMatches = routeCandidates.flatMap((route, routeHypothesisId) =>
        (route.mentionMatches ?? [])
          .filter((match) => match.mentionIndex === mentionIndex)
          .map((match) => ({ route, routeHypothesisId, match })));
      const stations = new Map((perMentionPools[mentionIndex] ?? []).map((station) => [station.id, station]));
      for (const { match } of routeMatches) stations.set(match.station.id, match.station);
      return [...stations.values()].map((station): MentionStationCandidate => {
        const { nameSimilarity, kanaSimilarity, phoneticSimilarity, lexicalSimilarity } = lexicalSimilarities(
          mentionText,
          station,
          phoneticHints[mentionIndex],
        );
        const bound = boundNamesByMention[mentionIndex] === station.name;
        const supportingRoutes = routeMatches.filter(({ match }) => match.station.id === station.id);
        const bestRouteScore = supportingRoutes.reduce<number | null>(
          (best, { route }) => best === null || route.score > best ? route.score : best,
          null,
        );
        const conflictsWithMatchedRoute = !bound && routeCandidates.length > 0 && supportingRoutes.length === 0;
        const hardMatch = bound || nameSimilarity === 1 || kanaSimilarity === 1
          || Math.max(nameSimilarity, kanaSimilarity) >= 0.85;
        const lexicalBase = Math.min(
          0.85,
          nameSimilarity * 0.35 + kanaSimilarity * 0.35 + phoneticSimilarity * 0.15,
        );
        const evidenceScore = lexicalBase * (conflictsWithMatchedRoute ? 0.25 : 1)
          + (bestRouteScore ?? 0) * 0.4;
        const finalScore = bound ? Math.max(0.95, evidenceScore) : Math.min(1, evidenceScore);
        return {
          mentionIndex,
          mentionText,
          station,
          nameSimilarity,
          kanaSimilarity,
          phoneticSimilarity,
          bound,
          lexicalScore: lexicalSimilarity,
          matchStrength: hardMatch ? "hard" : "soft",
          routeHypothesisIds: supportingRoutes.map(({ routeHypothesisId }) => routeHypothesisId),
          bestRouteScore,
          finalScore,
        };
      })
        .filter((candidate) => candidate.lexicalScore >= 0.2 || candidate.bestRouteScore !== null)
        .sort((left, right) => right.finalScore - left.finalScore || right.lexicalScore - left.lexicalScore)
        .slice(0, STATION_SEQUENCE_LIMITS.uniqueCandidatesPerMention);
    });
    const totalMs = Date.now() - totalStartedAt;
    const metrics: StationSequenceMetrics = {
      mentions: mentionTexts?.length ?? 0,
      surfaceCandidateCount: surfacePools.reduce((sum, values) => sum + values.length, 0),
      phoneticCandidateCount: phoneticPools.reduce((sum, values) => sum + values.length, 0),
      uniqueCandidateCount: perMentionPools.reduce((sum, values) => sum + values.length, 0),
      lineIdsLoaded: Math.ceil(lineRouteCandidates.length / 2),
      routeHypothesesGenerated: lineRouteCandidates.length + graphRoutes.length,
      routeHypothesesKept: routeCandidates.length,
      graphSearchCount: sequenceFallbackAttempted ? 1 : 0,
      fallbackExecuted: sequenceFallbackAttempted,
      fallbackSeedCount: sequenceFallbackAttempted ? fallbackSeedNames.length : 0,
      alignmentRouteCount: lineRouteCandidates.length + graphRoutes.length,
      alignmentComparisonCount,
      d1QueryCount: Math.max(0, (this.repository.getQueryCount?.() ?? initialQueryCount) - initialQueryCount),
      candidateGenerationMs,
      lineLookupMs,
      hypothesisGenerationMs,
      graphSearchMs,
      alignmentMs,
      reconciliationMs: 0,
      totalMs,
    };
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

export function reconcileStationMentionCandidates(
  sequenceDiagnostics: readonly StationCandidateDiagnostics[],
): Map<string, Station> {
  const startedAt = Date.now();
  const occurrences = new Map<string, MentionStationCandidate[][]>();
  for (const diagnostics of sequenceDiagnostics) {
    for (const candidates of diagnostics.mentionCandidates) {
      const rawMention = candidates[0]?.mentionText;
      if (rawMention === undefined) continue;
      const key = stationMentionBindingKey(rawMention);
      const values = occurrences.get(key) ?? [];
      values.push(candidates);
      occurrences.set(key, values);
    }
  }
  const bindings = new Map<string, Station>();
  for (const [key, candidateLists] of occurrences) {
    if (candidateLists.length < 2) continue;
    const evidenceByStation = new Map<string, { station: Station; score: number; support: number }>();
    for (const candidates of candidateLists) {
      for (const candidate of candidates.slice(0, 3)) {
        const routeEvidence = candidate.bestRouteScore !== null
          && candidate.bestRouteScore >= 0.55
          && candidate.lexicalScore >= 0.2;
        const surfaceEvidence = Math.max(candidate.nameSimilarity, candidate.kanaSimilarity) >= 0.85;
        if (!routeEvidence && !surfaceEvidence) continue;
        const evidence = candidate.finalScore
          + (candidate.bestRouteScore ?? 0) * 0.1
          + Math.max(candidate.nameSimilarity, candidate.kanaSimilarity) * 0.1;
        const existing = evidenceByStation.get(candidate.station.name);
        if (existing === undefined) {
          evidenceByStation.set(candidate.station.name, { station: candidate.station, score: evidence, support: 1 });
        } else {
          existing.score = Math.max(existing.score, evidence);
          existing.support += 1;
        }
      }
    }
    const ranked = [...evidenceByStation.values()]
      .map((value) => ({ ...value, score: value.score + Math.min(0.1, (value.support - 1) * 0.05) }))
      .sort((left, right) => right.score - left.score);
    const winner = ranked[0];
    if (winner === undefined || winner.score < 0.55 || winner.score - (ranked[1]?.score ?? 0) < 0.04) continue;
    bindings.set(key, winner.station);
    for (const candidates of candidateLists) {
      const mentionIndex = candidates[0]?.mentionIndex ?? 0;
      const mentionText = candidates[0]?.mentionText ?? key;
      const local = candidates.find(({ station }) => station.name === winner.station.name);
      const template = local ?? candidateLists
        .flat()
        .find(({ station }) => station.name === winner.station.name);
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
        .filter(({ station }) => station.name !== winner.station.name)
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
