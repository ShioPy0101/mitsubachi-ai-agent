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
  findCandidatePool(searchText: string, context: StationContext, limit: number): Promise<Station[]>;
  findRouteCandidates(
    anchorNames: readonly string[],
    maxCandidates: number,
    endpointContextStations?: number,
  ): Promise<RoutePathCandidate[]>;
  findLocalRouteCandidates?(
    seedNames: readonly string[],
    sequenceLength: number,
    maxCandidates: number,
    stationRadius?: number,
  ): Promise<RoutePathCandidate[]>;
}

export type SequenceSearchOptions = {
  sequenceRole?: SequenceRole;
  destinationContext?: boolean;
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

function lexicalSimilarities(mention: string, station: Station): {
  nameSimilarity: number;
  kanaSimilarity: number;
  lexicalSimilarity: number;
} {
  const nameSimilarity = stationNameSimilarity(mention, station.name);
  const kanaSimilarity = stationKanaSimilarity(mention, station.kana);
  return { nameSimilarity, kanaSimilarity, lexicalSimilarity: Math.max(nameSimilarity, kanaSimilarity) };
}

function alignMentionsToRoute(
  mentionTexts: readonly string[],
  route: RoutePathCandidate,
  source: "anchor" | "sequence_fallback",
  hardAnchorNamesByMention: readonly ReadonlySet<string>[],
  maximumStationGap = 4,
): RoutePathCandidate | null {
  if (mentionTexts.length < 2 || route.stations.length < mentionTexts.length) return null;
  const effectiveMaximumStationGap = Math.min(
    16,
    Math.max(maximumStationGap, Math.ceil(route.stations.length / mentionTexts.length) * 2),
  );
  const alignmentValue = (mentionIndex: number, station: Station): number => {
    const lexical = lexicalSimilarities(mentionTexts[mentionIndex] ?? "", station).lexicalSimilarity;
    const hardNames = hardAnchorNamesByMention[mentionIndex] ?? new Set<string>();
    if (hardNames.size === 0) return lexical * 0.75;
    return lexical * 0.75 + (hardNames.has(station.name) ? 0.5 : -0.35);
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
      ...lexicalSimilarities(mentionTexts[mentionIndex] ?? "", station),
    };
  });
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
    const searchText = extractStationSearchText(transcription);
    const pools = await Promise.all([
      this.repository.findCandidatePool(searchText, context, 100),
      ...(mentionTexts ?? []).map((mention) =>
        this.repository.findCandidatePool(extractStationSearchText(mention), context, 40)),
    ]);
    const pool = [...new Map(pools.flat().map((station) => [station.id, station])).values()];
    const eligiblePool = pool.filter((station) => isEligibleStationMention(station, transcription));
    const initial = eligiblePool
      .map((station) => scoreStation(station, transcription, context));
    const hardAnchorNamesByMention = (mentionTexts ?? []).map((mention) => new Set(pool
      .filter((station) => {
        const similarities = lexicalSimilarities(mention, station);
        return similarities.nameSimilarity === 1 || similarities.kanaSimilarity === 1;
      })
      .map(({ name }) => name)));
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
    const anchorRouteCandidates = anchorNames.length >= 2
      ? await this.repository.findRouteCandidates(anchorNames, 5, 2)
      : [];
    const alignedAnchorRoutes = mentionTexts === null
      ? anchorRouteCandidates.map((route) => ({ ...route, source: "anchor" as const }))
      : anchorRouteCandidates
        .map((route) => alignMentionsToRoute(
          mentionTexts,
          route,
          "anchor",
          hardAnchorNamesByMention,
          options.sequenceRole === "direction" ? 16 : 4,
        ))
        .filter((route): route is RoutePathCandidate => route !== null);
    const anchorSearchStatus = anchorNames.length < 2
      ? "insufficient_anchors" as const
      : alignedAnchorRoutes.length === 0
        ? "inconsistent_anchors" as const
        : "matched" as const;
    const sequenceFallbackAttempted = mentionTexts !== null
      && this.repository.findLocalRouteCandidates !== undefined
      && (options.destinationContext === true || alignedAnchorRoutes.length === 0 || alignedAnchorRoutes[0]!.score < 0.65);
    let fallbackRoutes: RoutePathCandidate[] = [];
    if (sequenceFallbackAttempted && mentionTexts !== null && this.repository.findLocalRouteCandidates !== undefined) {
      const perMentionSeeds = mentionTexts.flatMap((mention) => pool
        .map((station) => ({ station, ...lexicalSimilarities(mention, station) }))
        .filter(({ lexicalSimilarity }) => lexicalSimilarity >= 0.5)
        .sort((left, right) => right.lexicalSimilarity - left.lexicalSimilarity)
        .slice(0, 3)
        .map(({ station }) => station.name));
      const seedNames = [...new Set([...anchorNames, ...perMentionSeeds])].slice(0, 20);
      const maximumStationGap = options.sequenceRole === "direction" ? 16 : 4;
      const stationRadius = options.destinationContext === true
        ? Math.max(16, mentionTexts.length * 4)
        : mentionTexts.length + 2;
      const localRoutes = await this.repository.findLocalRouteCandidates(
        seedNames,
        mentionTexts.length,
        30,
        stationRadius,
      );
      fallbackRoutes = localRoutes
        .map((route) => alignMentionsToRoute(
          mentionTexts,
          route,
          "sequence_fallback",
          hardAnchorNamesByMention,
          maximumStationGap,
        ))
        .filter((route): route is RoutePathCandidate => route !== null);
    }
    const routeCandidates = deduplicateRoutes([...alignedAnchorRoutes, ...fallbackRoutes])
      .sort((left, right) => right.score - left.score || left.transferCount - right.transferCount)
      .slice(0, 5);
    const fallbackSearchStatus = !sequenceFallbackAttempted
      ? "not_attempted" as const
      : fallbackRoutes.length > 0
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
    const candidates = [...combined.values()]
      .map((station) => scoreStation(station, transcription, context))
      .map((candidate): StationCandidate => {
        const route = routeById.get(candidate.station.id);
        if (route === undefined) {
          const exactButRouteInconsistent = routeCandidates.length > 0
            && (candidate.nameSimilarity === 1 || candidate.kanaSimilarity === 1);
          return exactButRouteInconsistent ? { ...candidate, score: candidate.score * 0.6 } : candidate;
        }
        const routeRankFactor = Math.max(0.4, 1 - route.bestRouteRank * 0.15);
        const matchedRoute = routeCandidates[route.bestRouteRank];
        const fallbackFactor = matchedRoute?.source === "sequence_fallback" ? 0.4 : STATION_MATCH_WEIGHTS.exactPath;
        const routeQualityFactor = matchedRoute?.source === "sequence_fallback"
          ? route.bestRouteScore
          : route.bestRouteScore >= 0.8 ? 1 : route.bestRouteScore;
        const routeContextBonus = fallbackFactor * routeRankFactor * routeQualityFactor;
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
      const stations = new Map(pool.map((station) => [station.id, station]));
      for (const { match } of routeMatches) stations.set(match.station.id, match.station);
      return [...stations.values()].map((station): MentionStationCandidate => {
        const { nameSimilarity, kanaSimilarity, lexicalSimilarity } = lexicalSimilarities(mentionText, station);
        const supportingRoutes = routeMatches.filter(({ match }) => match.station.id === station.id);
        const bestRouteScore = supportingRoutes.reduce<number | null>(
          (best, { route }) => best === null || route.score > best ? route.score : best,
          null,
        );
        const conflictsWithMatchedRoute = routeCandidates.length > 0 && supportingRoutes.length === 0;
        const hardMatch = nameSimilarity === 1 || kanaSimilarity === 1 || lexicalSimilarity >= 0.85;
        const lexicalBase = Math.min(0.7, nameSimilarity * 0.35 + kanaSimilarity * 0.35);
        const finalScore = Math.min(1,
          lexicalBase * (conflictsWithMatchedRoute ? 0.25 : 1)
            + (bestRouteScore ?? 0) * 0.4,
        );
        return {
          mentionIndex,
          mentionText,
          station,
          nameSimilarity,
          kanaSimilarity,
          lexicalScore: lexicalSimilarity,
          matchStrength: hardMatch ? "hard" : "soft",
          routeHypothesisIds: supportingRoutes.map(({ routeHypothesisId }) => routeHypothesisId),
          bestRouteScore,
          finalScore,
        };
      })
        .filter((candidate) => candidate.lexicalScore >= 0.2 || candidate.bestRouteScore !== null)
        .sort((left, right) => right.finalScore - left.finalScore || right.lexicalScore - left.lexicalScore)
        .slice(0, 8);
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
    };
  }
}
