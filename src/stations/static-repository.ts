import { STATION_SEQUENCE_LIMITS } from "./candidate-service";
import type { LineCandidateSeed, StationRepository } from "./candidate-service";
import {
  extractStationSearchText,
  normalizeStationName,
  normalizeKana,
} from "./normalization";
import { rankLineEvidence, materializeLineRoutes } from "./line-routes";
import { bestContainedSimilarity, stringSimilarity } from "./similarity";
import {
  comparePathCost,
  enumerateSegmentPaths,
  scoreRoute,
  MAX_ROUTE_EXPANSION_FACTOR,
  type PositionedStation,
  type PathSegment,
  type SegmentPath,
} from "./route-algorithms";
import type {
  Station,
  StationContext,
  RoutePathCandidate,
  RoutePathStation,
  PhysicalRoute,
  LineTransition,
} from "./types";
import type { RailwayIndexes } from "./static-indexes";
import { normalizeLocalizedStationName } from "./language";

export type StaticRailwayJobCache = {
  positions: Map<string, PositionedStation[]>;
  lineRoutes: Map<string, Promise<RoutePathCandidate[]>>;
  graphRoutes: Map<string, Promise<RoutePathCandidate[]>>;
  sequenceRoutes: Map<string, Promise<RoutePathCandidate[]>>;
};
export const createStaticRailwayJobCache = (): StaticRailwayJobCache => ({
  positions: new Map(),
  lineRoutes: new Map(),
  graphRoutes: new Map(),
  sequenceRoutes: new Map(),
});
export class StaticRailwayRepository implements StationRepository {
  private rowsReturned = 0;
  private routeLoadingMs = 0;
  private hits = 0;
  private misses = 0;
  private sequencePreRankComparisons = 0;
  constructor(
    private readonly indexes: RailwayIndexes,
    private readonly cache = createStaticRailwayJobCache(),
  ) {}
  getQueryCount() {
    return 0;
  }
  getCostMetrics() {
    return {
      rowsReturned: this.rowsReturned,
      d1RowsRead: 0,
      lineRouteLoadingMs: this.routeLoadingMs,
      cacheHits: this.hits,
      cacheMisses: this.misses,
      sequencePreRankComparisons: this.sequencePreRankComparisons,
    };
  }
  private containing(text: string, kind: "name" | "kana"): Station[] {
    if (!text) return [];
    const grams =
      kind === "name" ? this.indexes.nameGrams : this.indexes.kanaGrams;
    const exact = kind === "name" ? this.indexes.byName : this.indexes.byKana;
    const result = new Map<number, Station>();
    for (const station of grams.get(text.slice(0, Math.min(2, text.length))) ??
      [])
      result.set(station.id, station);
    // Names contained in a noisy surface string are found by indexed substrings.
    for (let start = 0; start < text.length; start++)
      for (
        let end = start + 1;
        end <= Math.min(text.length, start + 32);
        end++
      ) {
        for (const station of exact.get(text.slice(start, end)) ?? [])
          result.set(station.id, station);
      }
    return [...result.values()];
  }
  async findCandidatePool(
    searchText: string,
    context: StationContext,
    limit: number,
  ): Promise<Station[]> {
    return (
      (
        await this.findCandidatePools(
          [searchText],
          [searchText],
          context,
          limit,
          limit,
        )
      ).surface[0] ?? []
    );
  }
  async findCandidatePools(
    surfaceTexts: readonly string[],
    phoneticHints: readonly (string | null)[],
    context: StationContext,
    surfaceLimit: number,
    phoneticLimit: number,
  ): Promise<{ surface: Station[][]; phonetic: Station[][] }> {
    const surface: Station[][] = [];
    const phonetic: Station[][] = [];

    for (let index = 0; index < surfaceTexts.length; index++) {
      const rawText = surfaceTexts[index]!;
      const text = extractStationSearchText(rawText);

      const exact =
        this.indexes.byName.get(normalizeStationName(rawText)) ??
        this.indexes.byLocalizedName.get(
          normalizeLocalizedStationName(rawText),
        ) ??
        [];

      const pool = new Map(this.containing(text, "name").map((s) => [s.id, s]));

      for (const station of exact) {
        pool.set(station.id, station);
      }

      for (let start = 0; start < text.length; start++) {
        for (
          let end = start + 1;
          end <= Math.min(text.length, start + 32);
          end++
        ) {
          for (const station of this.indexes.byAdjacent.get(
            text.slice(start, end),
          ) ?? []) {
            pool.set(station.id, station);
          }
        }
      }

      for (const name of [context.previousStation, context.nextStation]) {
        if (!name) continue;

        for (const station of this.indexes.byAdjacent.get(name) ?? []) {
          pool.set(station.id, station);
        }
      }

      const candidates = [...pool.values()]
        .filter((station) => {
          const name = this.indexes.byId.get(station.id)!.normalizedName;

          return (
            text &&
            (text.includes(name) ||
              name.includes(text) ||
              exact.some((exactStation) => exactStation.id === station.id) ||
              (station.prevStation && text.includes(station.prevStation)) ||
              (station.nextStation && text.includes(station.nextStation)) ||
              (context.lineName &&
                station.lineName === context.lineName &&
                name.startsWith(text.slice(0, 2))) ||
              (context.prefecture &&
                station.prefecture === context.prefecture &&
                name.startsWith(text.slice(0, 2))) ||
              (context.previousStation &&
                [station.prevStation, station.nextStation].includes(
                  context.previousStation,
                )) ||
              (context.nextStation &&
                [station.prevStation, station.nextStation].includes(
                  context.nextStation,
                )))
          );
        })
        .sort(
          (a, b) =>
            Number(text.includes(this.indexes.byId.get(b.id)!.normalizedName)) -
              Number(
                text.includes(this.indexes.byId.get(a.id)!.normalizedName),
              ) ||
            Number(
              b.lineName === context.lineName && context.lineName !== null,
            ) -
              Number(
                a.lineName === context.lineName && context.lineName !== null,
              ) ||
            Math.abs(
              this.indexes.byId.get(a.id)!.normalizedName.length - text.length,
            ) -
              Math.abs(
                this.indexes.byId.get(b.id)!.normalizedName.length -
                  text.length,
              ) ||
            a.id - b.id,
        )
        .slice(0, surfaceLimit);

      surface.push(candidates);

      const hint = phoneticHints[index];
      if (!hint) {
        phonetic.push([]);
        continue;
      }

      const reading = normalizeKana(extractStationSearchText(hint));

      const phoneticCandidates = [...this.indexes.byId.values()]
        .map((station) => {
          const kana = station.normalizedKana;

          return {
            station,
            // At equal similarity, retain the leading reading before a suffix
            // (やすゆき → やす ahead of ゆき) within the bounded pool.
            readingPrefix:
              kana != null &&
              kana.length > 0 &&
              reading.startsWith(normalizeKana(kana)),
            similarity:
              kana == null
                ? 0
                : Math.max(
                    stringSimilarity(reading, normalizeKana(kana)),
                    bestContainedSimilarity(reading, normalizeKana(kana)),
                  ),
          };
        })
        .filter(({ similarity }) => similarity >= 0.6)
        .sort(
          (a, b) =>
            b.similarity - a.similarity ||
            Number(b.readingPrefix) - Number(a.readingPrefix) ||
            Math.abs((a.station.normalizedKana?.length ?? 0) - reading.length) -
              Math.abs(
                (b.station.normalizedKana?.length ?? 0) - reading.length,
              ) ||
            a.station.id - b.station.id,
        )
        .slice(0, phoneticLimit)
        .map(({ station }) => station);

      phonetic.push(phoneticCandidates);
    }

    this.rowsReturned += surface.flat().length + phonetic.flat().length;

    return {
      surface: surface.map((pool) => pool.map(publicStation)),
      phonetic: phonetic.map((pool) => pool.map(publicStation)),
    };
  }
  async findLineRouteCandidates(
    candidates: readonly LineCandidateSeed[],
    maxLines: number,
  ): Promise<RoutePathCandidate[]> {
    const key =
      maxLines +
      ":" +
      candidates
        .map((c) => `${c.stationId}:${c.mentionIndex}:${c.strength}`)
        .sort()
        .join("|");
    const cached = this.cache.lineRoutes.get(key);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const load = Promise.resolve().then(() => {
      const memberships = [
        ...new Set(candidates.map((c) => c.stationId)),
      ].flatMap((id) => this.indexes.memberships.get(id) ?? []);
      const lines = rankLineEvidence(candidates, memberships, maxLines);
      const positions = new Map(
        lines.map(({ lineId }) => {
          const full = this.positions(lineId);
          const support = memberships
            .filter((m) => m.line_id === lineId)
            .map((m) => m.seq);
          if (
            full.length > STATION_SEQUENCE_LIMITS.routeLength &&
            support.length
          ) {
            const lower = Math.max(0, Math.min(...support) - 6),
              upper = Math.max(...support) + 6;
            const window = full.filter((p) => p.seq >= lower && p.seq <= upper);
            if (window.length <= STATION_SEQUENCE_LIMITS.routeLength)
              return [lineId, window] as const;
          }
          return [lineId, full] as const;
        }),
      );
      return materializeLineRoutes(lines, positions).map((route, index) => {
        const path = this.indexes.pathsById.get(
          lines[Math.floor(index / 2)]!.lineId,
        )!;
        const direction =
          index % 2 === 0 ? ("forward" as const) : ("reverse" as const);
        return {
          ...route,
          direction,
          physicalStations: route.stations,
          physicalRoute: {
            segments: [
              {
                lineId: path.lineId,
                pathId: path.pathId,
                stationIds: route.stations.map((s) => s.station.id),
                direction,
              },
            ],
          },
          lineTransitions: [],
          directionReversals: 0,
        };
      });
    });
    this.cache.lineRoutes.set(key, load);
    return load;
  }
  async findSequenceLineRouteCandidates(
    mentions: readonly string[],
    hints: readonly (string | null)[],
    maxLines: number,
  ): Promise<RoutePathCandidate[]> {
    if (mentions.length < 2 || maxLines < 1) return [];
    const key =
      maxLines +
      ":" +
      mentions
        .map(
          (m, i) =>
            `${m.length}:${m}:${hints[i]?.length ?? 0}:${hints[i] ?? ""}`,
        )
        .join("|");
    const cached = this.cache.sequenceRoutes.get(key);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const load = Promise.resolve().then(() => {
      // Score each station/mention once; shared paths reuse the same evidence.
      // This is a separate lexical co-occurrence hypothesis, never a binding.
      const normalizedMentions = mentions.map(normalizeStationName);
      const normalizedHints = hints.map((h) => (h ? normalizeKana(h) : null));
      const exactPathIds = new Set(
        normalizedMentions.flatMap((m) =>
          (this.indexes.byName.get(m) ?? []).flatMap((station) =>
            (this.indexes.memberships.get(station.id) ?? []).map(
              (membership) => membership.line_id,
            ),
          ),
        ),
      );
      if (!exactPathIds.size) return []; // No anchor: retain the independent strict/graph result.
      const paths = [...exactPathIds].map((id) =>
        this.indexes.pathsById.get(id)!,
      );
      let comparisons = 0;
      const scores = new Map<number, number[]>();
      for (const id of new Set(paths.flatMap((path) => path.stationIds))) {
        const station = this.indexes.byId.get(id)!;
        scores.set(
          station.id,
          normalizedMentions.map((mention, i) =>
            Math.max(
              bestContainedSimilarity(mention, station.normalizedName),
              normalizedHints[i] && station.normalizedKana
                ? bestContainedSimilarity(
                    normalizedHints[i]!,
                    station.normalizedKana,
                  ) * 0.5
                : 0,
            ),
          ),
        );
      }
      const lines = paths
        .map((path) => {
          const cost = 2 * mentions.length * path.stationIds.length;
          if (
            comparisons + cost > 20_000 ||
            path.stationIds.length > STATION_SEQUENCE_LIMITS.routeLength
          )
            return { lineId: path.pathId, preScore: -1 };
          comparisons += cost;
          this.sequencePreRankComparisons += cost;
          const orderedStrength = (ids: readonly number[]) => {
            if (ids.length < mentions.length) return 0;
            let previous = ids.map((id) => scores.get(id)![0]!);
            for (let i = 1; i < mentions.length; i++) {
              let best = -Infinity;
              previous = ids.map((id, j) => {
                if (j) best = Math.max(best, previous[j - 1]!);
                return best + scores.get(id)![i]!;
              });
            }
            return Math.max(0, ...previous) / Math.max(1, mentions.length);
          };
          return {
            lineId: path.pathId,
            preScore: Math.max(
              orderedStrength(path.stationIds),
              orderedStrength([...path.stationIds].reverse()),
            ),
          };
        })
        .filter((line) => line.preScore >= 0)
        .sort(
          (a, b) => b.preScore - a.preScore || a.lineId.localeCompare(b.lineId),
        )
        .slice(0, maxLines);
      return materializeLineRoutes(
        lines,
        new Map(lines.map((l) => [l.lineId, this.positions(l.lineId)])),
      );
    });
    this.cache.sequenceRoutes.set(key, load);
    return load;
  }

  private positions(pathId: string): PositionedStation[] {
    const cached = this.cache.positions.get(pathId);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const loadStarted = Date.now();
    const positions = (
      this.indexes.pathsById.get(pathId)?.stationIds ?? []
    ).map((id, seq) => ({
      station: publicStation(this.indexes.byId.get(id)!),
      lineId: pathId,
      seq,
    }));
    this.routeLoadingMs += Date.now() - loadStarted;
    this.cache.positions.set(pathId, positions);
    return positions;
  }
  private async findAnchorOccurrences(
    names: readonly string[],
  ): Promise<PositionedStation[]> {
    const occurrences = names.flatMap((name) =>
      (this.indexes.byName.get(name) ?? []).flatMap((station) =>
        (this.indexes.memberships.get(station.id) ?? []).map((m) => ({
          station: publicStation(station),
          lineId: m.line_id,
          seq: m.seq,
        })),
      ),
    );
    return occurrences.sort(
      (a, b) => a.lineId.localeCompare(b.lineId) || a.seq - b.seq,
    );
  }
  private async expandSegment(
    segment: PathSegment,
  ): Promise<PositionedStation[]> {
    const lower = Math.min(segment.fromSeq, segment.toSeq),
      upper = Math.max(segment.fromSeq, segment.toSeq);
    const result = this.positions(segment.lineId).filter(
      (s) => s.seq >= lower && s.seq <= upper,
    );
    return segment.fromSeq <= segment.toSeq ? result : result.reverse();
  }
  private async expandPath(
    path: SegmentPath,
    endpointContextStations: number,
  ): Promise<{
    stations: RoutePathStation[];
    physicalRoute: PhysicalRoute;
    lineTransitions: LineTransition[];
  }> {
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
    const physicalSegments: PhysicalRoute["segments"][number][] = [];
    const lineTransitions: LineTransition[] = [];
    for (const segment of segments) {
      const values = await this.expandSegment(segment);
      const path = this.indexes.pathsById.get(segment.lineId)!;
      const previous = physicalSegments.at(-1);
      if (previous && values[0])
        lineTransitions.push({
          fromLineId: previous.lineId,
          toLineId: path.lineId,
          atStationId: previous.stationIds.at(-1)!,
          toStationId: values[0].station.id,
        });
      physicalSegments.push({
        lineId: path.lineId,
        pathId: path.pathId,
        stationIds: values.map((v) => v.station.id),
        direction: segment.toSeq >= segment.fromSeq ? "forward" : "reverse",
      });
      for (const positioned of values) {
        // Only station identity deduplicates the shared connection endpoint.
        if (stations.at(-1)?.id !== positioned.station.id)
          stations.push(positioned.station);
      }
    }
    return {
      stations: stations.map((station, routeIndex) => ({
        station,
        routeIndex,
      })),
      physicalRoute: { segments: physicalSegments },
      lineTransitions,
    };
  }

  async findRouteCandidates(
    anchorNames: readonly string[],
    maxCandidates: number,
    endpointContextStations = 0,
  ): Promise<RoutePathCandidate[]> {
    const key =
      `${maxCandidates}:${endpointContextStations}:` +
      anchorNames.map((name) => `${name.length}:${name}`).join("|");
    const cached = this.cache.graphRoutes.get(key);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const load = this.loadRouteCandidates(
      anchorNames,
      maxCandidates,
      endpointContextStations,
    );
    this.cache.graphRoutes.set(key, load);
    return load;
  }
  private async loadRouteCandidates(
    anchorNames: readonly string[],
    maxCandidates: number,
    endpointContextStations = 0,
  ): Promise<RoutePathCandidate[]> {
    if (anchorNames.length < 2 || maxCandidates < 1) return [];
    const occurrences = await this.findAnchorOccurrences(anchorNames);
    const endpointPairs: Array<readonly [number, number]> = [
      [0, anchorNames.length - 1],
    ];
    for (let index = 0; index + 1 < anchorNames.length; index += 1)
      endpointPairs.push([index, index + 1]);
    const uniquePairs = [
      ...new Map(
        endpointPairs.map(([start, end]) => [
          `${start}:${end}`,
          [start, end] as const,
        ]),
      ).values(),
    ];
    const graph = this.indexes.graph;
    const segmentPaths: SegmentPath[] = [];
    const endpointPriority = new Map<SegmentPath, number>();
    for (const [startIndex, goalIndex] of uniquePairs) {
      const startName = anchorNames[startIndex];
      const goalName = anchorNames[goalIndex];
      if (startName === undefined || goalName === undefined) continue;
      const starts = occurrences.filter(
        ({ station }) => station.name === startName,
      );
      const goals = occurrences.filter(
        ({ station }) => station.name === goalName,
      );
      const found = enumerateSegmentPaths(
        starts,
        goals,
        graph,
        maxCandidates * 2,
      );
      for (const path of found)
        endpointPriority.set(
          path,
          startIndex === 0 && goalIndex === anchorNames.length - 1 ? 0 : 1,
        );
      segmentPaths.push(...found);
    }
    if (segmentPaths.length === 0) return [];
    const boundedSegmentPaths = segmentPaths
      .sort(
        (a, b) =>
          endpointPriority.get(a)! - endpointPriority.get(b)! ||
          comparePathCost(a, b),
      )
      .slice(0, maxCandidates * MAX_ROUTE_EXPANSION_FACTOR);
    const expanded: Array<{
      stations: RoutePathStation[];
      transferCount: number;
      physicalRoute: PhysicalRoute;
      lineTransitions: LineTransition[];
    }> = [];
    const stationSignatures = new Set<string>();
    for (const path of boundedSegmentPaths) {
      const physical = await this.expandPath(path, endpointContextStations);
      const stations = physical.stations;
      const signature = stations.map(({ station }) => station.id).join(",");
      if (stations.length === 0 || stationSignatures.has(signature)) continue;
      stationSignatures.add(signature);
      expanded.push({ ...physical, transferCount: path.transferCount });
    }
    const shortestLength = Math.min(
      ...expanded
        .filter(({ stations }) =>
          anchorNames.every((name) =>
            stations.some((s) => s.station.name === name),
          ),
        )
        .map(({ stations }) => stations.length),
    );
    return expanded
      .map(
        ({
          stations,
          transferCount,
          physicalRoute,
          lineTransitions,
        }): RoutePathCandidate => {
          const visited = new Set<number>();
          let repeated = 0;
          for (const { station } of stations) {
            if (visited.has(station.id)) repeated++;
            visited.add(station.id);
          }
          const scoring = scoreRoute(
            stations,
            anchorNames,
            transferCount,
            Number.isFinite(shortestLength) ? shortestLength : stations.length,
          );
          return {
            stations,
            physicalStations: stations,
            physicalRoute,
            lineTransitions,
            direction: physicalRoute.segments[0]?.direction ?? "forward",
            // Path-local seq directions cannot be compared across unrelated lines.
            // A physical station revisit detects genuine backtracking instead.
            directionReversals: repeated,
            ...scoring,
            score: Math.max(0, scoring.score - repeated * 0.15),
          };
        },
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.anchorCoverage - left.anchorCoverage ||
          right.orderConsistency - left.orderConsistency ||
          left.transferCount - right.transferCount ||
          left.pathLength - right.pathLength,
      )
      .slice(0, maxCandidates);
  }
}

function publicStation(value: Station): Station {
  const { normalizedName, normalizedKana, ...station } = value as Station & {
    normalizedName?: string;
    normalizedKana?: string | null;
  };
  return station;
}
