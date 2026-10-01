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
  exactPath: 0.25,
  nearPath: 0.1,
} as const;

export type RoutePathStation = {
  station: Station;
  routeIndex: number;
};

export type RoutePathCandidate = {
  stations: RoutePathStation[];
  anchorCoverage: number;
  orderConsistency: number;
  transferCount: number;
  pathLength: number;
  score: number;
  source?: "line_fast_path" | "graph_fallback";
  mentionMatches?: MentionRouteMatch[];
  exactAnchorCoverage?: number;
  hardAnchorViolations?: number;
};

export type MentionRouteMatch = {
  mentionIndex: number;
  mentionText: string;
  station: Station;
  routeIndex: number;
  nameSimilarity: number;
  kanaSimilarity: number;
  phoneticSimilarity: number;
  lexicalSimilarity: number;
};

export type StationMatchStrength = "hard" | "soft";

export type MentionStationCandidate = {
  mentionIndex: number;
  mentionText: string;
  station: Station;
  nameSimilarity: number;
  kanaSimilarity: number;
  phoneticSimilarity: number;
  bound: boolean;
  lexicalScore: number;
  matchStrength: StationMatchStrength;
  routeHypothesisIds: number[];
  bestRouteScore: number | null;
  finalScore: number;
};

export type RouteSearchStatus =
  | "matched"
  | "insufficient_anchors"
  | "inconsistent_anchors"
  | "no_route_match";

export type StationCandidate = {
  station: Station;
  nameSimilarity: number;
  kanaSimilarity: number;
  lineBonus: number;
  prefectureBonus: number;
  adjacencyBonus: number;
  routeContextBonus: number;
  routeSupported: boolean;
  onExactPath: boolean;
  nearPath: boolean;
  routeOrderConsistent: boolean;
  routeIndex: number | null;
  previousAnchor: string | null;
  nextAnchor: string | null;
  routeCandidateIds: number[];
  bestRouteRank: number | null;
  anchor: boolean;
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
