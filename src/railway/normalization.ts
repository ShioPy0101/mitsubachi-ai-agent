export function compactTranscript(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}
