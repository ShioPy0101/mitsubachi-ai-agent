// Leave enough time to edit Discord's original response before its 15-minute callback expires.
export const staleAudioJobTimeoutMs = 12 * 60 * 1000;

export function staleAudioJobCutoff(now: Date): string {
  return new Date(now.getTime() - staleAudioJobTimeoutMs).toISOString();
}
