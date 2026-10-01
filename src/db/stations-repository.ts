import { z } from "zod";
import type { LineCandidateSeed, StationRepository } from "../stations/candidate-service";
import { extractStationSearchText } from "../stations/normalization";
import type { RoutePathCandidate, RoutePathStation, Station, StationContext } from "../stations/types";

const StationRowSchema = z.object({
  id: z.number().int(), name: z.string(), kana: z.string().nullable(), kana_source: z.string().nullable(),
  operator_name: z.string().nullable(), line_name: z.string().nullable(), prefecture: z.string().nullable(),
  prev_station: z.string().nullable(), next_station: z.string().nullable(), longitude: z.number().nullable(),
  latitude: z.number().nullable(), postal: z.string().nullable(),
});
const PositionedStationRowSchema = StationRowSchema.extend({ line_id: z.string(), seq: z.number().int() });
const CandidateStationRowSchema = StationRowSchema.extend({ mention_index: z.number().int().nonnegative() });
const CandidateLineMembershipRowSchema = z.object({
  line_id: z.string(), station_id: z.number().int(), seq: z.number().int(),
});
const ConnectionRowSchema = z.object({
  from_segment_id: z.string(), to_segment_id: z.string(),
  from_station_id: z.number().int(), to_station_id: z.number().int(),
  from_seq: z.number().int(), to_seq: z.number().int(), transfer_cost: z.number().int().min(0).max(1),
});

type PositionedStation = { station: Station; lineId: string; seq: number };
type SegmentConnection = z.output<typeof ConnectionRowSchema>;
export type D1StationsJobCache = {
  lineRoutes: Map<string, Promise<RoutePathCandidate[]>>;
  connections?: Promise<SegmentConnection[]>;
};

export function createD1StationsJobCache(): D1StationsJobCache {
  return { lineRoutes: new Map() };
}
type PathSegment = { lineId: string; fromSeq: number; toSeq: number };
type SegmentPath = { segments: PathSegment[]; transferCount: number; distance: number };
type SearchState = SegmentPath & { lineId: string; seq: number; visited: Set<string> };

const MAX_TRANSFERS = 3;
const MAX_SEGMENTS = 8;
const MAX_EXPANDED_STATES = 5_000;
const MAX_ROUTE_EXPANSION_FACTOR = 4;
const stationColumns = `station.id, station.name, station.kana, station.kana_source,
  station.operator_name, station.line_name, station.prefecture, station.prev_station,
  station.next_station, station.longitude, station.latitude, station.postal`;

const toStation = (input: unknown): Station => {
  const row = StationRowSchema.parse(input);
  return {
    id: row.id, name: row.name, kana: row.kana, kanaSource: row.kana_source, operatorName: row.operator_name,
    lineName: row.line_name, prefecture: row.prefecture, prevStation: row.prev_station,
    nextStation: row.next_station, longitude: row.longitude, latitude: row.latitude, postal: row.postal,
  };
};

const toPositionedStation = (input: unknown): PositionedStation => {
  const row = PositionedStationRowSchema.parse(input);
  return { station: toStation(row), lineId: row.line_id, seq: row.seq };
};

function comparePathCost(left: SegmentPath, right: SegmentPath): number {
  return left.transferCount - right.transferCount
    || left.distance - right.distance
    || left.segments.length - right.segments.length;
}

function heapPush(heap: SearchState[], value: SearchState): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    const parentValue = heap[parent];
    if (parentValue === undefined || comparePathCost(parentValue, value) <= 0) break;
    heap[index] = parentValue;
    index = parent;
  }
  heap[index] = value;
}

function heapPop(heap: SearchState[]): SearchState | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (first === undefined || last === undefined || heap.length === 0) return first;
  let index = 0;
  while (true) {
    const leftIndex = index * 2 + 1;
    const rightIndex = leftIndex + 1;
    const left = heap[leftIndex];
    const right = heap[rightIndex];
    if (left === undefined) break;
    const childIndex = right !== undefined && comparePathCost(right, left) < 0 ? rightIndex : leftIndex;
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

function enumerateSegmentPaths(
  starts: readonly PositionedStation[],
  goals: readonly PositionedStation[],
  connections: readonly SegmentConnection[],
  limit: number,
): SegmentPath[] {
  const connectionsBySegment = new Map<string, SegmentConnection[]>();
  for (const connection of connections) {
    const values = connectionsBySegment.get(connection.from_segment_id) ?? [];
    values.push(connection);
    connectionsBySegment.set(connection.from_segment_id, values);
  }
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

  while (frontier.length > 0 && paths.length < limit && expanded < MAX_EXPANDED_STATES) {
    const current = heapPop(frontier);
    if (current === undefined) break;
    expanded += 1;

    for (const goal of goals) {
      if (goal.lineId !== current.lineId) continue;
      const path: SegmentPath = {
        segments: [...current.segments, { lineId: current.lineId, fromSeq: current.seq, toSeq: goal.seq }],
        transferCount: current.transferCount,
        distance: current.distance + Math.abs(goal.seq - current.seq),
      };
      const signature = path.segments.map((segment) => `${segment.lineId}:${segment.fromSeq}-${segment.toSeq}`).join("|");
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
        segments: [...current.segments, {
          lineId: current.lineId,
          fromSeq: current.seq,
          toSeq: connection.from_seq,
        }],
        transferCount,
        distance: current.distance + Math.abs(connection.from_seq - current.seq),
        visited: new Set([...current.visited, nextKey]),
      });
    }
  }
  return paths.sort(comparePathCost);
}

function longestCommonSubsequence(left: readonly string[], right: readonly string[]): number {
  let previous = Array.from({ length: right.length + 1 }, () => 0);
  for (const leftValue of left) {
    const current = [0];
    for (let index = 1; index <= right.length; index += 1) {
      current[index] = leftValue === right[index - 1]
        ? (previous[index - 1] ?? 0) + 1
        : Math.max(previous[index] ?? 0, current[index - 1] ?? 0);
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function scoreRoute(
  stations: RoutePathStation[],
  anchorNames: readonly string[],
  transferCount: number,
  shortestLength: number,
): Omit<RoutePathCandidate, "stations"> {
  const stationNames = stations.map(({ station }) => station.name);
  const coveredAnchors = anchorNames.filter((anchor) => stationNames.includes(anchor)).length;
  const anchorCoverage = anchorNames.length === 0 ? 0 : coveredAnchors / anchorNames.length;
  const orderedAnchors = longestCommonSubsequence(anchorNames, stationNames);
  const orderConsistency = coveredAnchors === 0 ? 0 : orderedAnchors / coveredAnchors;
  const pathLength = stations.length;
  const detourRatio = pathLength === 0 ? 1 : Math.max(0, pathLength - shortestLength) / pathLength;
  const localPathAllowance = Math.max(4, anchorNames.length * 4);
  const localityPenalty = Math.min(0.55, Math.max(0, pathLength - localPathAllowance) * 0.015);
  const score = Math.max(0, Math.min(1,
    anchorCoverage * 0.55
      + orderConsistency * 0.35
      - transferCount * 0.08
      - detourRatio * 0.1
      - localityPenalty,
  ));
  return { anchorCoverage, orderConsistency, transferCount, pathLength, score };
}

export class D1StationsRepository implements StationRepository {
  private queryCount = 0;

  constructor(
    private readonly db: D1Database,
    private readonly cache: D1StationsJobCache = createD1StationsJobCache(),
  ) {}

  getQueryCount(): number { return this.queryCount; }

  async findCandidatePool(searchText: string, context: StationContext, limit: number): Promise<Station[]> {
    this.queryCount += 1;
    const prefix = searchText.slice(0, 2);
    const result = await this.db.prepare(`
      SELECT id, name, kana, kana_source, operator_name, line_name, prefecture,
             prev_station, next_station, longitude, latitude, postal
      FROM stations
      WHERE instr(?, normalized_name) > 0
         OR instr(?, normalized_kana) > 0
         OR normalized_kana LIKE ? || '%'
         OR (prev_station IS NOT NULL AND instr(?, prev_station) > 0)
         OR (next_station IS NOT NULL AND instr(?, next_station) > 0)
         OR (? IS NOT NULL AND line_name = ?)
         OR (? IS NOT NULL AND prefecture = ?)
         OR (? IS NOT NULL AND (prev_station = ? OR next_station = ?))
         OR (? IS NOT NULL AND (prev_station = ? OR next_station = ?))
      ORDER BY
        CASE WHEN instr(?, normalized_name) > 0 OR instr(?, normalized_kana) > 0 THEN 0 ELSE 1 END,
        CASE WHEN line_name = ? THEN 0 ELSE 1 END,
        abs(length(COALESCE(normalized_kana, normalized_name)) - length(?))
      LIMIT ?
    `).bind(
      searchText, searchText, prefix, searchText, searchText,
      context.lineName ?? null, context.lineName ?? null,
      context.prefecture ?? null, context.prefecture ?? null,
      context.previousStation ?? null, context.previousStation ?? null, context.previousStation ?? null,
      context.nextStation ?? null, context.nextStation ?? null, context.nextStation ?? null,
      searchText, searchText, context.lineName ?? null, searchText, limit,
    ).all();
    return result.results.map(toStation);
  }

  async findCandidatePools(
    surfaceTexts: readonly string[],
    phoneticHints: readonly (string | null)[],
    context: StationContext,
    surfaceLimit: number,
    phoneticLimit: number,
  ): Promise<{ surface: Station[][]; phonetic: Station[][] }> {
    const surface = surfaceTexts.map((): Station[] => []);
    const phonetic = surfaceTexts.map((): Station[] => []);
    if (surfaceTexts.length === 0) return { surface, phonetic };
    const values = surfaceTexts.map(() => "(?, ?)").join(", ");
    this.queryCount += 1;
    const surfaceRows = await this.db.prepare(`
      WITH search_terms(mention_index, search_text) AS (VALUES ${values}),
      search_context(line_name, prefecture, previous_station, next_station) AS (VALUES (?, ?, ?, ?)),
      ranked AS (
        SELECT search_terms.mention_index, ${stationColumns},
          ROW_NUMBER() OVER (
            PARTITION BY search_terms.mention_index
            ORDER BY
              CASE WHEN instr(search_terms.search_text, station.normalized_name) > 0 THEN 0 ELSE 1 END,
              CASE WHEN station.line_name = search_context.line_name THEN 0 ELSE 1 END,
              abs(length(station.normalized_name) - length(search_terms.search_text)),
              station.id
          ) AS candidate_rank
        FROM search_terms
        CROSS JOIN search_context
        INNER JOIN stations station ON
          instr(search_terms.search_text, station.normalized_name) > 0
          OR instr(station.normalized_name, search_terms.search_text) > 0
          OR (station.prev_station IS NOT NULL AND instr(search_terms.search_text, station.prev_station) > 0)
          OR (station.next_station IS NOT NULL AND instr(search_terms.search_text, station.next_station) > 0)
          OR (search_context.line_name IS NOT NULL AND station.line_name = search_context.line_name)
          OR (search_context.prefecture IS NOT NULL AND station.prefecture = search_context.prefecture)
          OR (search_context.previous_station IS NOT NULL
            AND (station.prev_station = search_context.previous_station OR station.next_station = search_context.previous_station))
          OR (search_context.next_station IS NOT NULL
            AND (station.prev_station = search_context.next_station OR station.next_station = search_context.next_station))
      )
      SELECT * FROM ranked WHERE candidate_rank <= ? ORDER BY mention_index, candidate_rank
    `).bind(
      ...surfaceTexts.flatMap((text, index) => [index, extractStationSearchText(text)]),
      context.lineName ?? null,
      context.prefecture ?? null,
      context.previousStation ?? null,
      context.nextStation ?? null,
      surfaceLimit,
    ).all();
    for (const input of surfaceRows.results) {
      const row = CandidateStationRowSchema.parse(input);
      surface[row.mention_index]?.push(toStation(row));
    }

    const phoneticTerms = phoneticHints.flatMap((hint, index) =>
      hint === null ? [] : [{ index, text: extractStationSearchText(hint) }]);
    if (phoneticTerms.length === 0) return { surface, phonetic };
    const phoneticValues = phoneticTerms.map(() => "(?, ?)").join(", ");
    this.queryCount += 1;
    const phoneticRows = await this.db.prepare(`
      WITH search_terms(mention_index, search_text) AS (VALUES ${phoneticValues}),
      ranked AS (
        SELECT search_terms.mention_index, ${stationColumns},
          ROW_NUMBER() OVER (
            PARTITION BY search_terms.mention_index
            ORDER BY
              CASE WHEN instr(search_terms.search_text, station.normalized_kana) > 0 THEN 0 ELSE 1 END,
              abs(length(station.normalized_kana) - length(search_terms.search_text)),
              station.id
          ) AS candidate_rank
        FROM search_terms
        INNER JOIN stations station ON station.normalized_kana IS NOT NULL AND (
          instr(search_terms.search_text, station.normalized_kana) > 0
          OR instr(station.normalized_kana, search_terms.search_text) > 0
          OR station.normalized_kana LIKE substr(search_terms.search_text, 1, 2) || '%'
        )
      )
      SELECT * FROM ranked WHERE candidate_rank <= ? ORDER BY mention_index, candidate_rank
    `).bind(
      ...phoneticTerms.flatMap(({ index, text }) => [index, text]),
      phoneticLimit,
    ).all();
    for (const input of phoneticRows.results) {
      const row = CandidateStationRowSchema.parse(input);
      phonetic[row.mention_index]?.push(toStation(row));
    }
    return { surface, phonetic };
  }

  async findLineRouteCandidates(
    candidates: readonly LineCandidateSeed[],
    maxLines: number,
  ): Promise<RoutePathCandidate[]> {
    const stationIds = [...new Set(candidates.map(({ stationId }) => stationId))];
    if (stationIds.length === 0 || maxLines < 1) return [];
    const cacheKey = JSON.stringify({ maxLines, candidates });
    const cached = this.cache.lineRoutes.get(cacheKey);
    if (cached !== undefined) return cached;
    const request = this.loadLineRouteCandidates(candidates, stationIds, maxLines);
    this.cache.lineRoutes.set(cacheKey, request);
    try {
      return await request;
    } catch (error) {
      this.cache.lineRoutes.delete(cacheKey);
      throw error;
    }
  }

  private async loadLineRouteCandidates(
    candidates: readonly LineCandidateSeed[],
    stationIds: readonly number[],
    maxLines: number,
  ): Promise<RoutePathCandidate[]> {
    const stationPlaceholders = stationIds.map(() => "?").join(", ");
    this.queryCount += 1;
    const membershipRows = await this.db.prepare(`
      SELECT line_id, station_id, seq
      FROM station_line_positions
      WHERE station_id IN (${stationPlaceholders})
      ORDER BY line_id, seq
    `).bind(...stationIds).all();
    const memberships = membershipRows.results.map((row) => CandidateLineMembershipRowSchema.parse(row));
    const seedsByStation = new Map<number, LineCandidateSeed[]>();
    for (const candidate of candidates) {
      const values = seedsByStation.get(candidate.stationId) ?? [];
      values.push(candidate);
      seedsByStation.set(candidate.stationId, values);
    }
    const lineEvidence = new Map<string, Array<LineCandidateSeed & { seq: number }>>();
    for (const membership of memberships) {
      const values = lineEvidence.get(membership.line_id) ?? [];
      for (const seed of seedsByStation.get(membership.station_id) ?? []) {
        values.push({ ...seed, seq: membership.seq });
      }
      lineEvidence.set(membership.line_id, values);
    }
    const lines = [...lineEvidence]
      .map(([lineId, evidence]) => {
        const bestByMention = [...new Map(evidence
          .sort((left, right) => right.strength - left.strength)
          .map((item) => [item.mentionIndex, item])).values()]
          .sort((left, right) => left.mentionIndex - right.mentionIndex);
        const directions = bestByMention.slice(1).map((item, index) =>
          Math.sign(item.seq - (bestByMention[index]?.seq ?? item.seq)));
        const increasing = directions.filter((value) => value >= 0).length;
        const decreasing = directions.filter((value) => value <= 0).length;
        const orderConsistency = directions.length === 0 ? 0.5 : Math.max(increasing, decreasing) / directions.length;
        const coverage = bestByMention.length / Math.max(1, new Set(candidates.map(({ mentionIndex }) => mentionIndex)).size);
        const meanStrength = bestByMention.reduce((sum, item) => sum + item.strength, 0)
          / Math.max(1, bestByMention.length);
        return {
          lineId,
          preScore: coverage * 0.5 + meanStrength * 0.35 + orderConsistency * 0.15,
        };
      })
      .sort((left, right) => right.preScore - left.preScore || left.lineId.localeCompare(right.lineId))
      .slice(0, maxLines);
    if (lines.length === 0) return [];
    const linePlaceholders = lines.map(() => "?").join(", ");
    this.queryCount += 1;
    const positionedRows = await this.db.prepare(`
      SELECT ${stationColumns}, position.line_id, position.seq
      FROM station_line_positions position
      INNER JOIN stations station ON station.id = position.station_id
      WHERE position.line_id IN (${linePlaceholders})
      ORDER BY position.line_id, position.seq
    `).bind(...lines.map(({ lineId }) => lineId)).all();
    const byLine = new Map<string, PositionedStation[]>();
    for (const input of positionedRows.results) {
      const positioned = toPositionedStation(input);
      const values = byLine.get(positioned.lineId) ?? [];
      values.push(positioned);
      byLine.set(positioned.lineId, values);
    }
    return lines.flatMap(({ lineId, preScore }): RoutePathCandidate[] => {
      const values = byLine.get(lineId) ?? [];
      if (values.length === 0) return [];
      const forward = values.map(({ station }, routeIndex) => ({ station, routeIndex }));
      const reverse = [...values].reverse().map(({ station }, routeIndex) => ({ station, routeIndex }));
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

  private async findAnchorOccurrences(anchorNames: readonly string[]): Promise<PositionedStation[]> {
    const placeholders = anchorNames.map(() => "?").join(", ");
    this.queryCount += 1;
    const result = await this.db.prepare(`
      SELECT ${stationColumns}, position.line_id, position.seq
      FROM station_line_positions position
      INNER JOIN stations station ON station.id = position.station_id
      WHERE station.name IN (${placeholders})
      ORDER BY position.line_id, position.seq
    `).bind(...anchorNames).all();
    return result.results.map(toPositionedStation);
  }

  private async findConnections(): Promise<SegmentConnection[]> {
    if (this.cache.connections !== undefined) return this.cache.connections;
    const request = this.loadConnections();
    this.cache.connections = request;
    try {
      return await request;
    } catch (error) {
      delete this.cache.connections;
      throw error;
    }
  }

  private async loadConnections(): Promise<SegmentConnection[]> {
    this.queryCount += 1;
    const result = await this.db.prepare(`
      SELECT from_segment_id, to_segment_id, from_station_id, to_station_id,
             from_seq, to_seq, transfer_cost
      FROM route_segment_connections
      ORDER BY from_segment_id, from_seq, to_segment_id, to_seq
    `).all();
    return result.results.map((row) => ConnectionRowSchema.parse(row));
  }

  private async expandSegment(segment: PathSegment): Promise<PositionedStation[]> {
    const lower = Math.min(segment.fromSeq, segment.toSeq);
    const upper = Math.max(segment.fromSeq, segment.toSeq);
    const direction = segment.fromSeq <= segment.toSeq ? "ASC" : "DESC";
    this.queryCount += 1;
    const result = await this.db.prepare(`
      SELECT ${stationColumns}, position.line_id, position.seq
      FROM station_line_positions position
      INNER JOIN stations station ON station.id = position.station_id
      WHERE position.line_id = ? AND position.seq BETWEEN ? AND ?
      ORDER BY position.seq ${direction}
    `).bind(segment.lineId, lower, upper).all();
    return result.results.map(toPositionedStation);
  }

  private async expandPath(path: SegmentPath, endpointContextStations: number): Promise<RoutePathStation[]> {
    const segments = path.segments.map((segment) => ({ ...segment }));
    const first = segments[0];
    const last = segments.at(-1);
    if (first !== undefined && endpointContextStations > 0) {
      const direction = Math.sign(first.toSeq - first.fromSeq);
      first.fromSeq -= direction * endpointContextStations;
    }
    if (last !== undefined && endpointContextStations > 0) {
      const direction = Math.sign(last.toSeq - last.fromSeq);
      last.toSeq += direction * endpointContextStations;
    }
    const stations: Station[] = [];
    for (const segment of segments) {
      for (const positioned of await this.expandSegment(segment)) {
        if (stations.at(-1)?.name !== positioned.station.name) stations.push(positioned.station);
      }
    }
    return stations.map((station, routeIndex) => ({ station, routeIndex }));
  }

  async findRouteCandidates(
    anchorNames: readonly string[],
    maxCandidates: number,
    endpointContextStations = 0,
  ): Promise<RoutePathCandidate[]> {
    if (anchorNames.length < 2 || maxCandidates < 1) return [];
    const occurrences = await this.findAnchorOccurrences(anchorNames);
    const endpointPairs: Array<readonly [number, number]> = [[0, anchorNames.length - 1]];
    for (let index = 0; index + 1 < anchorNames.length; index += 1) endpointPairs.push([index, index + 1]);
    const uniquePairs = [...new Map(endpointPairs.map(([start, end]) => [`${start}:${end}`, [start, end] as const])).values()];
    const connections = await this.findConnections();
    const segmentPaths: SegmentPath[] = [];
    for (const [startIndex, goalIndex] of uniquePairs) {
      const startName = anchorNames[startIndex];
      const goalName = anchorNames[goalIndex];
      if (startName === undefined || goalName === undefined) continue;
      const starts = occurrences.filter(({ station }) => station.name === startName);
      const goals = occurrences.filter(({ station }) => station.name === goalName);
      segmentPaths.push(...enumerateSegmentPaths(starts, goals, connections, maxCandidates * 2));
    }
    if (segmentPaths.length === 0) return [];
    const boundedSegmentPaths = segmentPaths.sort(comparePathCost).slice(0, maxCandidates * MAX_ROUTE_EXPANSION_FACTOR);
    const expanded: Array<{ stations: RoutePathStation[]; transferCount: number }> = [];
    const stationSignatures = new Set<string>();
    for (const path of boundedSegmentPaths) {
      const stations = await this.expandPath(path, endpointContextStations);
      const signature = stations.map(({ station }) => station.id).join(",");
      if (stations.length === 0 || stationSignatures.has(signature)) continue;
      stationSignatures.add(signature);
      expanded.push({ stations, transferCount: path.transferCount });
    }
    const shortestLength = Math.min(...expanded.map(({ stations }) => stations.length));
    return expanded
      .map(({ stations, transferCount }): RoutePathCandidate => ({
        stations,
        ...scoreRoute(stations, anchorNames, transferCount, shortestLength),
      }))
      .sort((left, right) => right.score - left.score
        || right.anchorCoverage - left.anchorCoverage
        || right.orderConsistency - left.orderConsistency
        || left.transferCount - right.transferCount
        || left.pathLength - right.pathLength)
      .slice(0, maxCandidates);
  }

}
