import type { StationCandidate, StationResolution } from "./types";

export function resolveStation(
  candidates: readonly StationCandidate[],
  geminiStation: string | null,
): StationResolution {
  if (candidates.length === 0) {
    return { stationName: null, candidateStationId: null, confidence: 0, source: "unresolved" };
  }
  if (geminiStation === null) {
    return {
      stationName: null,
      candidateStationId: null,
      confidence: candidates[0]?.score ?? 0,
      source: "unresolved",
    };
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
  return {
    stationName: null,
    candidateStationId: null,
    confidence: candidates[0]?.score ?? 0,
    source: "unresolved",
  };
}
