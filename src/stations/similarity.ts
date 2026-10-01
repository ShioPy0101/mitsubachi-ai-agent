import { normalizeKana, normalizeStationName } from "./normalization";

export function levenshteinDistance(left: string, right: string): number {
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] ?? 0;
      const deletion = previous[rightIndex] ?? 0;
      const insertion = current[rightIndex - 1] ?? 0;
      current[rightIndex] = Math.min(
        deletion + 1,
        insertion + 1,
        substitution + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

export function stringSimilarity(left: string, right: string): number {
  const maximumLength = Math.max(left.length, right.length);
  if (maximumLength === 0) return 1;
  return Math.max(0, 1 - levenshteinDistance(left, right) / maximumLength);
}

export function bestContainedSimilarity(
  haystack: string,
  needle: string,
): number {
  if (needle.length === 0) return 0;
  if (haystack.includes(needle)) return 1;
  let best = stringSimilarity(haystack, needle);
  const minimum = Math.max(1, needle.length - 2);
  const maximum = Math.min(haystack.length, needle.length + 2);
  for (let length = minimum; length <= maximum; length += 1) {
    for (let start = 0; start + length <= haystack.length; start += 1) {
      best = Math.max(
        best,
        stringSimilarity(haystack.slice(start, start + length), needle),
      );
    }
  }
  return best;
}

export function stationNameMentionSimilarity(
  mention: string,
  stationName: string,
): number {
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
): number {
  return stationKana === null
    ? 0
    : bestContainedSimilarity(
        normalizeKana(transcription),
        normalizeKana(stationKana),
      );
}
