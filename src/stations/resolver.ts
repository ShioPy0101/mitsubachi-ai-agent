import type { StationCandidate, StationResolution } from "./types";

export function resolveStation(
  candidates: readonly StationCandidate[],
  geminiStation: string | null,
): StationResolution {
  if (candidates.length === 0) {
    return { stationName: null, candidateStationId: null, confidence: 0, source: "unresolved" };
  }
  const selected = geminiStation === null ? undefined : candidates.find(({ station }) => station.name === geminiStation);
  if (selected !== undefined) {
    return {
      stationName: selected.station.name,
      candidateStationId: selected.station.id,
      confidence: selected.score,
      source: "gemini",
    };
  }
  const best = candidates[0];
  if (best === undefined || best.score < 0.72) {
    return { stationName: null, candidateStationId: null, confidence: best?.score ?? 0, source: "unresolved" };
  }
  const source = best.nameSimilarity === 1
    ? "exact"
    : best.kanaSimilarity === 1
      ? "kana"
      : best.adjacencyBonus > 0 || best.routeContextBonus > 0
        ? "context"
        : "fuzzy";
  return { stationName: best.station.name, candidateStationId: best.station.id, confidence: best.score, source };
}
