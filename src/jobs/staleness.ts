export function audioJobElapsedMs(
  createdAt: string,
  startedAt: string | null,
  now: Date,
): number | null {
  const effectiveStartedAt = Date.parse(startedAt ?? createdAt);
  if (!Number.isFinite(effectiveStartedAt)) return null;
  return Math.max(0, now.getTime() - effectiveStartedAt);
}

export function isStaleAudioJob(deadlineAt: string | null, now: Date): boolean {
  const deadline = deadlineAt === null ? NaN : Date.parse(deadlineAt);
  return Number.isFinite(deadline) && deadline <= now.getTime();
}
