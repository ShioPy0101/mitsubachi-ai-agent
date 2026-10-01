import type { Station, RoutePathStation, RoutePathCandidate } from "./types";
export type PositionedStation = {
  station: Station;
  lineId: string;
  seq: number;
};
export type SegmentConnection = {
  from_segment_id: string;
  to_segment_id: string;
  from_station_id: number;
  to_station_id: number;
  from_seq: number;
  to_seq: number;
  transfer_cost: number;
};
export type CachedRouteGraph = {
  connections: SegmentConnection[];
  byFromSegment: Map<string, SegmentConnection[]>;
};
export interface RouteGraphRepository {
  load(): Promise<SegmentConnection[]>;
}
export type PathSegment = { lineId: string; fromSeq: number; toSeq: number };
export type SegmentPath = {
  segments: PathSegment[];
  transferCount: number;
  distance: number;
};
type SearchState = SegmentPath & {
  lineId: string;
  seq: number;
  visited: Set<string>;
};
const MAX_TRANSFERS = 3,
  MAX_SEGMENTS = 8,
  MAX_EXPANDED_STATES = 5_000;
export const MAX_ROUTE_EXPANSION_FACTOR = 4;
export function indexRouteGraph(
  connections: SegmentConnection[],
): CachedRouteGraph {
  const byFromSegment = new Map<string, SegmentConnection[]>();
  for (const connection of connections) {
    const list = byFromSegment.get(connection.from_segment_id) ?? [];
    list.push(connection);
    byFromSegment.set(connection.from_segment_id, list);
  }
  return { connections, byFromSegment };
}
export function comparePathCost(left: SegmentPath, right: SegmentPath): number {
  return (
    left.distance - right.distance ||
    left.transferCount - right.transferCount ||
    left.segments.length - right.segments.length
  );
}

function heapPush(heap: SearchState[], value: SearchState): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    const parentValue = heap[parent];
    if (parentValue === undefined || comparePathCost(parentValue, value) <= 0)
      break;
    heap[index] = parentValue;
    index = parent;
  }
  heap[index] = value;
}

function heapPop(heap: SearchState[]): SearchState | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (first === undefined || last === undefined || heap.length === 0)
    return first;
  let index = 0;
  while (true) {
    const leftIndex = index * 2 + 1;
    const rightIndex = leftIndex + 1;
    const left = heap[leftIndex];
    const right = heap[rightIndex];
    if (left === undefined) break;
    const childIndex =
      right !== undefined && comparePathCost(right, left) < 0
        ? rightIndex
        : leftIndex;
    const child = heap[childIndex];
    if (child === undefined || comparePathCost(last, child) <= 0) break;
    heap[index] = child;
    index = childIndex;
  }
  heap[index] = last;
  return first;
}

function stateKey(lineId: string, seq: number): string {
  return `${lineId}\u0000${seq}`;
}

export function enumerateSegmentPaths(
  starts: readonly PositionedStation[],
  goals: readonly PositionedStation[],
  graph: CachedRouteGraph,
  limit: number,
): SegmentPath[] {
  const connectionsBySegment = graph.byFromSegment;
  const frontier: SearchState[] = [];
  for (const start of starts) {
    heapPush(frontier, {
      lineId: start.lineId,
      seq: start.seq,
      segments: [],
      transferCount: 0,
      distance: 0,
      visited: new Set([stateKey(start.lineId, start.seq)]),
    });
  }
  const paths: SegmentPath[] = [];
  const signatures = new Set<string>();
  let expanded = 0;

  while (
    frontier.length > 0 &&
    paths.length < limit &&
    expanded < MAX_EXPANDED_STATES
  ) {
    const current = heapPop(frontier);
    if (current === undefined) break;
    expanded += 1;

    for (const goal of goals) {
      if (goal.lineId !== current.lineId) continue;
      const path: SegmentPath = {
        segments: [
          ...current.segments,
          { lineId: current.lineId, fromSeq: current.seq, toSeq: goal.seq },
        ],
        transferCount: current.transferCount,
        distance: current.distance + Math.abs(goal.seq - current.seq),
      };
      const signature = path.segments
        .map(
          (segment) => `${segment.lineId}:${segment.fromSeq}-${segment.toSeq}`,
        )
        .join("|");
      if (!signatures.has(signature)) {
        signatures.add(signature);
        paths.push(path);
      }
    }

    if (current.segments.length + 1 >= MAX_SEGMENTS) continue;
    for (const connection of connectionsBySegment.get(current.lineId) ?? []) {
      const transferCount = current.transferCount + connection.transfer_cost;
      if (transferCount > MAX_TRANSFERS) continue;
      const nextKey = stateKey(connection.to_segment_id, connection.to_seq);
      if (current.visited.has(nextKey)) continue;
      heapPush(frontier, {
        lineId: connection.to_segment_id,
        seq: connection.to_seq,
        segments: [
          ...current.segments,
          {
            lineId: current.lineId,
            fromSeq: current.seq,
            toSeq: connection.from_seq,
          },
        ],
        transferCount,
        distance:
          current.distance + Math.abs(connection.from_seq - current.seq),
        visited: new Set([...current.visited, nextKey]),
      });
    }
  }
  return paths.sort(comparePathCost);
}

function longestCommonSubsequence(
  left: readonly string[],
  right: readonly string[],
): number {
  let previous = Array.from({ length: right.length + 1 }, () => 0);
  for (const leftValue of left) {
    const current = [0];
    for (let index = 1; index <= right.length; index += 1) {
      current[index] =
        leftValue === right[index - 1]
          ? (previous[index - 1] ?? 0) + 1
          : Math.max(previous[index] ?? 0, current[index - 1] ?? 0);
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

export function scoreRoute(
  stations: RoutePathStation[],
  anchorNames: readonly string[],
  transferCount: number,
  shortestLength: number,
): Omit<RoutePathCandidate, "stations"> {
  const stationNames = stations.map(({ station }) => station.name);
  const coveredAnchors = anchorNames.filter((anchor) =>
    stationNames.includes(anchor),
  ).length;
  const anchorCoverage =
    anchorNames.length === 0 ? 0 : coveredAnchors / anchorNames.length;
  const orderedAnchors = longestCommonSubsequence(anchorNames, stationNames);
  const orderConsistency =
    coveredAnchors === 0 ? 0 : orderedAnchors / coveredAnchors;
  const pathLength = stations.length;
  const detourRatio =
    pathLength === 0
      ? 1
      : Math.max(0, pathLength - shortestLength) / pathLength;
  const localPathAllowance = Math.max(
    shortestLength,
    4,
    anchorNames.length * 4,
  );
  const localityPenalty = Math.min(
    0.55,
    Math.max(0, pathLength - localPathAllowance) * 0.015,
  );
  const score = Math.max(
    0,
    Math.min(
      1,
      anchorCoverage * 0.55 +
        orderConsistency * 0.35 -
        transferCount * 0.015 -
        detourRatio * 0.1 -
        localityPenalty,
    ),
  );
  return {
    anchorCoverage,
    orderConsistency,
    transferCount,
    pathLength,
    score,
    detourRatio,
  };
}
