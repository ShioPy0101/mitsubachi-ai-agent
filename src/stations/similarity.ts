import { normalizeKana, normalizeStationName } from "./normalization";
import { normalizeLocalizedStationName } from "./language";
import type { RailwayWorkMetrics } from "./work-metrics";
import { createRailwayWorkMetrics } from "./work-metrics";

/** One job owns this cache; keys include the operation and complete strings. */
export class StationSimilarityCache {
  constructor(readonly work = createRailwayWorkMetrics()) {}
  private normalized = new Map<string, string>();
  private scores = new Map<string, number>();
  normalize(text: string, kind: "name" | "kana" | "localized"): string {
    const key = JSON.stringify([kind, text]);
    const cached = this.normalized.get(key);
    if (cached !== undefined) {
      this.work.normalizationCacheHits++;
      return cached;
    }
    this.work.normalizationComputations++;
    const value =
      kind === "kana"
        ? normalizeKana(text)
        : kind === "name"
          ? normalizeStationName(text)
          : normalizeLocalizedStationName(text);
    this.normalized.set(key, value);
    return value;
  }
  similarity(left: string, right: string, contained = false): number {
    const key = JSON.stringify([contained, left, right]);
    const cached = this.scores.get(key);
    if (cached !== undefined) {
      this.work.similarityCacheHits++;
      return cached;
    }
    const value = contained
      ? bestContainedSimilarity(left, right, this.work)
      : stringSimilarity(left, right, this.work);
    this.scores.set(key, value);
    return value;
  }
}

export function levenshteinDistance(
  left: string,
  right: string,
  work?: RailwayWorkMetrics,
): number {
  if (work) {
    work.editDistanceCalls++;
    work.editDistanceCells += left.length * right.length;
  }
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (let i = 0; i <= right.length; i++) previous[i] = i;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length]!;
}

export function stringSimilarity(
  left: string,
  right: string,
  work?: RailwayWorkMetrics,
): number {
  const maximumLength = Math.max(left.length, right.length);
  if (maximumLength === 0) return 1;
  return Math.max(
    0,
    1 - levenshteinDistance(left, right, work) / maximumLength,
  );
}

export function bestContainedSimilarity(
  haystack: string,
  needle: string,
  work?: RailwayWorkMetrics,
): number {
  if (needle.length === 0) return 0;
  if (haystack.includes(needle)) return 1;
  let best = stringSimilarity(haystack, needle, work);
  const minimum = Math.max(1, needle.length - 2);
  const maximum = Math.min(haystack.length, needle.length + 2);
  for (let length = minimum; length <= maximum; length += 1) {
    for (let start = 0; start + length <= haystack.length; start += 1) {
      // Length difference is a lower bound on edit distance. Skip only when
      // this window cannot improve the exact current score.
      const maxLength = Math.max(length, needle.length);
      if (1 - Math.abs(length - needle.length) / maxLength <= best) continue;
      if (start === 0 && length === haystack.length) continue;
      best = Math.max(
        best,
        stringSimilarity(haystack.slice(start, start + length), needle, work),
      );
    }
  }
  return best;
}

export function stationNameMentionSimilarity(
  mention: string,
  stationName: string,
  cache?: StationSimilarityCache,
): number {
  if (cache)
    return cache.similarity(
      cache.normalize(mention, "name"),
      cache.normalize(stationName, "name"),
    );
  return stringSimilarity(
    normalizeStationName(mention),
    normalizeStationName(stationName),
  );
}

export function stationNameContainedSimilarity(
  transcription: string,
  stationName: string,
): number {
  return bestContainedSimilarity(
    normalizeStationName(transcription),
    normalizeStationName(stationName),
  );
}

export function stationKanaSimilarity(
  transcription: string,
  stationKana: string | null,
  cache?: StationSimilarityCache,
): number {
  if (cache)
    return stationKana === null
      ? 0
      : cache.similarity(
          cache.normalize(transcription, "kana"),
          cache.normalize(stationKana, "kana"),
          true,
        );
  return stationKana === null
    ? 0
    : bestContainedSimilarity(
        normalizeKana(transcription),
        normalizeKana(stationKana),
      );
}
