import type { MentionStationCandidate } from "./types";
export function compareMentionEvidence(
  left: MentionStationCandidate,
  right: MentionStationCandidate,
): number {
  return (
    Number(left.bound) - Number(right.bound) ||
    left.finalScore - right.finalScore ||
    (left.bestRouteScore ?? 0) - (right.bestRouteScore ?? 0) ||
    left.lexicalScore - right.lexicalScore ||
    right.station.id - left.station.id
  );
}
export function mergeMentionCandidates(
  lists: readonly (readonly MentionStationCandidate[])[],
): MentionStationCandidate[] {
  const strongest = new Map<number, MentionStationCandidate>();
  for (const candidate of lists.flat()) {
    const previous = strongest.get(candidate.station.id);
    if (!previous || compareMentionEvidence(candidate, previous) > 0)
      strongest.set(candidate.station.id, candidate);
  }
  return [...strongest.values()].sort((a, b) => compareMentionEvidence(b, a));
}
