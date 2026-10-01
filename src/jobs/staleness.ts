// Leave enough time to edit Discord's original response before its 15-minute callback expires.
export const staleAudioJobTimeoutMs = 12 * 60 * 1000;

export function staleAudioJobCutoff(now: Date): string {
  return new Date(now.getTime() - staleAudioJobTimeoutMs).toISOString();
}

export function audioJobElapsedMs(
  createdAt: string,
  startedAt: string | null,
  now: Date,
): number | null {
  const effectiveStartedAt = Date.parse(startedAt ?? createdAt);
  if (!Number.isFinite(effectiveStartedAt)) return null;
  return Math.max(0, now.getTime() - effectiveStartedAt);
}

export function isStaleAudioJob(
  createdAt: string,
  startedAt: string | null,
  now: Date,
): boolean {
  const elapsedMs = audioJobElapsedMs(createdAt, startedAt, now);
  return elapsedMs !== null && elapsedMs >= staleAudioJobTimeoutMs;
}
