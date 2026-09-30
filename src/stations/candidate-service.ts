import { extractStationSearchText, normalizeKana, normalizeStationName } from "./normalization";
import { stationKanaSimilarity, stationNameSimilarity } from "./similarity";
import {
  STATION_MATCH_WEIGHTS,
  type RoutePathCandidate,
  type Station,
  type StationCandidate,
  type StationContext,
} from "./types";

export interface StationRepository {
  findCandidatePool(searchText: string, context: StationContext, limit: number): Promise<Station[]>;
  findRouteCandidates(
    anchorNames: readonly string[],
    maxCandidates: number,
    endpointContextStations?: number,
  ): Promise<RoutePathCandidate[]>;
}

export type StationCandidateDiagnostics = {
  searchText: string;
  context: StationContext;
  pool: Station[];
  eligiblePool: Station[];
  anchorNames: string[];
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

export class StationCandidateService {
  constructor(private readonly repository: StationRepository) {}

  async candidates(transcription: string, context: StationContext = {}): Promise<StationCandidate[]> {
    return (await this.analyze(transcription, context)).candidates;
  }

  async analyze(transcription: string, context: StationContext = {}): Promise<StationCandidateDiagnostics> {
    const searchText = extractStationSearchText(transcription);
    const pool = await this.repository.findCandidatePool(searchText, context, 100);
    const eligiblePool = pool.filter((station) => isEligibleStationMention(station, transcription));
    const initial = eligiblePool
      .map((station) => scoreStation(station, transcription, context));
    const anchorNames = [...new Map(
      initial
        .filter((candidate) => candidate.nameSimilarity === 1 || candidate.kanaSimilarity === 1)
        .map((candidate) => [candidate.station.name, mentionIndex(candidate.station, transcription)]),
    )]
      .filter(([, index]) => index >= 0)
      .sort((left, right) => left[1] - right[1])
      .map(([name]) => name)
      .slice(0, 12);
    const routeCandidates = anchorNames.length >= 2
      ? await this.repository.findRouteCandidates(anchorNames, 5, 2)
      : [];
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
        const routeQualityFactor = route.bestRouteScore >= 0.8 ? 1 : route.bestRouteScore;
        const routeContextBonus = STATION_MATCH_WEIGHTS.exactPath * routeRankFactor * routeQualityFactor;
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
    return { searchText, context, pool, eligiblePool, anchorNames, routeCandidates, candidates };
  }
}
