import { extractStationSearchText } from "./normalization";
import { stationKanaSimilarity, stationNameSimilarity } from "./similarity";
import { STATION_MATCH_WEIGHTS, type Station, type StationCandidate, type StationContext } from "./types";

export interface StationRepository {
  findCandidatePool(searchText: string, context: StationContext, limit: number): Promise<Station[]>;
  findRouteCandidatePool(anchorNames: readonly string[], maxHops: number, limit: number): Promise<Station[]>;
}

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
  return { station, nameSimilarity, kanaSimilarity, lineBonus, prefectureBonus, adjacencyBonus, routeContextBonus: 0, score };
}

export class StationCandidateService {
  constructor(private readonly repository: StationRepository) {}

  async candidates(transcription: string, context: StationContext = {}): Promise<StationCandidate[]> {
    const searchText = extractStationSearchText(transcription);
    const pool = await this.repository.findCandidatePool(searchText, context, 100);
    const initial = pool
      .filter((station) => isEligibleStationMention(station, transcription))
      .map((station) => scoreStation(station, transcription, context));
    const anchorNames = [...new Set(
      initial.filter((candidate) => candidate.nameSimilarity === 1).map((candidate) => candidate.station.name),
    )].slice(0, 12);
    const routePool = anchorNames.length >= 2
      ? await this.repository.findRouteCandidatePool(anchorNames, 16, 100)
      : [];
    const routeIds = new Set(routePool.map((station) => station.id));
    const combined = new Map(
      pool.filter((station) => isEligibleStationMention(station, transcription)).map((station) => [station.id, station]),
    );
    for (const station of routePool) {
      if (isEligibleStationMention(station, transcription)) combined.set(station.id, station);
    }
    return [...combined.values()]
      .map((station) => scoreStation(station, transcription, context))
      .map((candidate): StationCandidate => {
        if (!routeIds.has(candidate.station.id)) return candidate;
        return {
          ...candidate,
          routeContextBonus: 1,
          score: Math.min(1, candidate.score + STATION_MATCH_WEIGHTS.route),
        };
      })
      .filter((candidate) => candidate.score >= 0.35)
      .sort((left, right) => right.score - left.score || left.station.name.localeCompare(right.station.name, "ja"))
      .filter((candidate, index, ranked) =>
        ranked.findIndex((item) => item.station.name === candidate.station.name) === index)
      .slice(0, 12);
  }
}
