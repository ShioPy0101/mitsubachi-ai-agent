export const audioJobProcessingTimeoutMs = 10 * 60 * 1000;
export const minimumWhisperProcessingTimeoutMs = 10 * 60 * 1000;
export const maximumWhisperProcessingTimeoutMs = 14 * 60 * 1000;

export function whisperProcessingTimeoutMs(durationSecs: number | null): number {
  if (durationSecs === null || !Number.isFinite(durationSecs) || durationSecs <= 0) {
    return audioJobProcessingTimeoutMs;
  }
  return Math.min(
    maximumWhisperProcessingTimeoutMs,
    Math.max(minimumWhisperProcessingTimeoutMs, Math.ceil(durationSecs * 3 * 1000)),
  );
}

export class AudioJobProcessingTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Audio job processing timed out after ${timeoutMs}ms`);
    this.name = "AudioJobProcessingTimeoutError";
  }
}

export async function withAudioJobProcessingTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs = audioJobProcessingTimeoutMs,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new AudioJobProcessingTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
