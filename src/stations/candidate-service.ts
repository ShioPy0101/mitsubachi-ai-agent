import { extractStationSearchText } from "./normalization";
import { stationKanaSimilarity, stationNameSimilarity } from "./similarity";
import { STATION_MATCH_WEIGHTS, type Station, type StationCandidate, type StationContext } from "./types";

export interface StationRepository {
  findCandidatePool(searchText: string, context: StationContext, limit: number): Promise<Station[]>;
}

function adjacencyScore(station: Station, context: StationContext): number {
  const previous = context.previousStation;
  const next = context.nextStation;
  const previousMatches = previous != null && (station.prevStation === previous || station.nextStation === previous);
  const nextMatches = next != null && (station.prevStation === next || station.nextStation === next);
  return previousMatches || nextMatches ? 1 : 0;
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
  return { station, nameSimilarity, kanaSimilarity, lineBonus, prefectureBonus, adjacencyBonus, score };
}

export class StationCandidateService {
  constructor(private readonly repository: StationRepository) {}

  async candidates(transcription: string, context: StationContext = {}): Promise<StationCandidate[]> {
    const searchText = extractStationSearchText(transcription);
    const pool = await this.repository.findCandidatePool(searchText, context, 100);
    return pool
      .map((station) => scoreStation(station, transcription, context))
      .filter((candidate) => candidate.score >= 0.35)
      .sort((left, right) => right.score - left.score || left.station.name.localeCompare(right.station.name, "ja"))
      .slice(0, 5);
  }
}
