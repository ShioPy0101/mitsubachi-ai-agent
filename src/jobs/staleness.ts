export const staleAudioJobTimeoutMs = 15 * 60 * 1000;

export function staleAudioJobCutoff(now: Date): string {
  return new Date(now.getTime() - staleAudioJobTimeoutMs).toISOString();
}
