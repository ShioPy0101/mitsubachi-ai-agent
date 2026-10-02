import type { RailwayIndexes } from "./static-indexes";

/** UTF-16 units match the existing edit-distance definition. Kana are BMP. */
export function readingCounts(reading: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of reading.split(""))
    counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export interface PhoneticCandidateSource {
  /** A superset of every candidate scoring >= 0.6, without a pre-ranking LIMIT. */
  findIds(normalizedReading: string): Promise<readonly number[]>;
  getCostMetrics(): {
    queries: number;
    rowsRead?: number;
    postingRows: number;
    returnedIds: number;
  };
}

export class IndexedStaticPhoneticSource implements PhoneticCandidateSource {
  private postingRows = 0;
  private returnedIds = 0;
  constructor(private readonly indexes: RailwayIndexes) {}
  getCostMetrics() {
    return {
      queries: 0,
      rowsRead: 0,
      postingRows: this.postingRows,
      returnedIds: this.returnedIds,
    };
  }
  async findIds(reading: string): Promise<number[]> {
    const overlap = new Map<number, number>();
    for (const [token, frequency] of readingCounts(reading)) {
      for (const entry of this.indexes.kanaPostings.get(token) ?? []) {
        this.postingRows++;
        overlap.set(
          entry.stationId,
          (overlap.get(entry.stationId) ?? 0) +
            Math.min(frequency, entry.frequency),
        );
      }
    }
    const result = [...overlap]
      .filter(([id, count]) => {
        const length = this.indexes.byId.get(id)!.normalizedKana!.length;
        return (
          length <= Math.floor(reading.length / 0.6) &&
          count >= Math.ceil(0.6 * length)
        );
      })
      .map(([id]) => id);
    this.returnedIds += result.length;
    return result;
  }
}

/** Necessary character-overlap condition, applied before expensive DP.
 * If similarity >= .6, edit distance <= floor(.4 * max length), so at least
 * ceil(.6 * max length) units must be shared. Every matching substring is
 * contained in the full reading's multiset. This is a lossless prefilter.
 */
export function canReachPhoneticThreshold(
  reading: string,
  kana: string,
): boolean {
  if (!kana) return false;
  if (reading.includes(kana)) return true;
  const target = readingCounts(kana);
  const compatible = (part: string) => {
    const length = Math.max(part.length, kana.length);
    if (Math.abs(part.length - kana.length) > Math.floor(0.4 * length + 1e-9))
      return false;
    let common = 0;
    for (const [token, count] of readingCounts(part))
      common += Math.min(count, target.get(token) ?? 0);
    return common >= Math.ceil(0.6 * length - 1e-9);
  };
  if (compatible(reading)) return true;
  for (
    let length = Math.max(1, kana.length - 2);
    length <= Math.min(reading.length, kana.length + 2);
    length++
  )
    for (let start = 0; start + length <= reading.length; start++)
      if (compatible(reading.slice(start, start + length))) return true;
  return false;
}
