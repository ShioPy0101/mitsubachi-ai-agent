import type { LineCandidateSeed } from "./candidate-service";
import type { PositionedStation } from "./route-algorithms";
import type { RoutePathCandidate } from "./types";
export type LineMembership = {
  line_id: string;
  station_id: number;
  seq: number;
};
export function rankLineEvidence(
  candidates: readonly LineCandidateSeed[],
  memberships: readonly LineMembership[],
  maxLines: number,
) {
  const seedsByStation = new Map<number, LineCandidateSeed[]>();
  for (const candidate of candidates) {
    const values = seedsByStation.get(candidate.stationId) ?? [];
    values.push(candidate);
    seedsByStation.set(candidate.stationId, values);
  }
  const lineEvidence = new Map<
    string,
    Array<LineCandidateSeed & { seq: number }>
  >();
  for (const membership of memberships) {
    const values = lineEvidence.get(membership.line_id) ?? [];
    for (const seed of seedsByStation.get(membership.station_id) ?? []) {
      values.push({ ...seed, seq: membership.seq });
    }
    lineEvidence.set(membership.line_id, values);
  }
  const lines = [...lineEvidence]
    .map(([lineId, evidence]) => {
      const bestByMention = [
        ...new Map(
          evidence
            .sort((left, right) => left.strength - right.strength)
            .map((item) => [item.mentionIndex, item]),
        ).values(),
      ].sort((left, right) => left.mentionIndex - right.mentionIndex);
      const directions = bestByMention
        .slice(1)
        .map((item, index) =>
          Math.sign(item.seq - (bestByMention[index]?.seq ?? item.seq)),
        );
      const increasing = directions.filter((value) => value >= 0).length;
      const decreasing = directions.filter((value) => value <= 0).length;
      const orderConsistency =
        directions.length === 0
          ? 0.5
          : Math.max(increasing, decreasing) / directions.length;
      const coverage =
        bestByMention.length /
        Math.max(
          1,
          new Set(candidates.map(({ mentionIndex }) => mentionIndex)).size,
        );
      const meanStrength =
        bestByMention.reduce((sum, item) => sum + item.strength, 0) /
        Math.max(1, bestByMention.length);
      return {
        lineId,
        preScore:
          coverage * 0.5 + meanStrength * 0.35 + orderConsistency * 0.15,
      };
    })
    .sort(
      (left, right) =>
        right.preScore - left.preScore ||
        left.lineId.localeCompare(right.lineId),
    )
    .slice(0, maxLines);
  return lines;
}
export function materializeLineRoutes(
  lines: readonly { lineId: string; preScore: number }[],
  byLine: ReadonlyMap<string, PositionedStation[]>,
): RoutePathCandidate[] {
  return lines.flatMap(({ lineId, preScore }): RoutePathCandidate[] => {
    const values = byLine.get(lineId) ?? [];
    if (values.length === 0) return [];
    const forward = values.map(({ station }, routeIndex) => ({
      station,
      routeIndex,
    }));
    const reverse = [...values]
      .reverse()
      .map(({ station }, routeIndex) => ({ station, routeIndex }));
    return [forward, reverse].map((stations) => ({
      stations,
      anchorCoverage: preScore,
      orderConsistency: 1,
      transferCount: 0,
      pathLength: stations.length,
      score: preScore,
      source: "line_fast_path",
    }));
  });
}
