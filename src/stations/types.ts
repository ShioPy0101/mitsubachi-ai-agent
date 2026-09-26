export type Station = {
  id: number;
  name: string;
  kana: string | null;
  kanaSource: string | null;
  operatorName: string | null;
  lineName: string | null;
  prefecture: string | null;
  prevStation: string | null;
  nextStation: string | null;
  longitude: number | null;
  latitude: number | null;
  postal: string | null;
};

export const STATION_MATCH_WEIGHTS = {
  name: 0.35,
  kana: 0.35,
  line: 0.1,
  prefecture: 0.05,
  adjacency: 0.15,
} as const;

export type StationCandidate = {
  station: Station;
  nameSimilarity: number;
  kanaSimilarity: number;
  lineBonus: number;
  prefectureBonus: number;
  adjacencyBonus: number;
  score: number;
};

export type StationResolution = {
  stationName: string | null;
  candidateStationId: number | null;
  confidence: number;
  source: "exact" | "kana" | "fuzzy" | "context" | "gemini" | "unresolved";
};

export type StationContext = {
  lineName?: string | null;
  prefecture?: string | null;
  previousStation?: string | null;
  nextStation?: string | null;
};
