import { stationEnglishName } from "../stations/language";
import type { AnnouncementAnalysis } from "./service";
import type { StopSequenceContext } from "./prompt";
import type { NormalizedEntity } from "./gemini";
import type { NormalizedAnnouncementEvent } from "../railway/semantic";
export type NormalizationObservation = {
  outcome: "generated" | "empty_output" | "invalid_output";
  inputCharacters: number;
  outputCharacters: number;
  entityCorrections: number;
  targetsOutsideEvidence: string[];
  unmatchedMentionIds: string[];
  missingSourceEventIds: string[];
  numericChanges: { raw: string[]; normalized: string[] } | null;
};
// This module never approves/rejects content or changes the generated text.
export function observeNormalization(
  raw: string,
  normalized: string,
  analysis: AnnouncementAnalysis,
  sequences: readonly StopSequenceContext[],
  entities: readonly NormalizedEntity[] = [],
  events?: readonly NormalizedAnnouncementEvent[],
): NormalizationObservation {
  const candidates = new Set(
    sequences.flatMap((s) =>
      s.mentionCandidates.flatMap((cs) =>
        cs.flatMap((c) =>
          [c.station.name, stationEnglishName(c.station)].filter(
            (n): n is string => n !== null,
          ),
        ),
      ),
    ),
  );
  const mentionIds = new Set(analysis.mentions.map((m) => m.id));
  const numbers = (text: string) =>
    [...text.normalize("NFKC").matchAll(/\d+(?:[:.]\d+)?/g)].map((m) => m[0]);
  const originalNumbers = numbers(raw),
    finalNumbers = numbers(normalized);
  return {
    outcome: "generated",
    inputCharacters: raw.length,
    outputCharacters: normalized.length,
    entityCorrections: entities.filter(
      (e) => e.sourceText && e.sourceText !== e.text,
    ).length,
    targetsOutsideEvidence: entities
      .filter(
        (e) =>
          (e.kind === "station" || e.kind === "destination") &&
          e.text !== e.sourceText &&
          !candidates.has(e.text),
      )
      .map((e) => e.text),
    unmatchedMentionIds: entities
      .filter((e) => e.sourceMentionId && !mentionIds.has(e.sourceMentionId))
      .map((e) => e.sourceMentionId!),
    missingSourceEventIds: events
      ? (analysis.semantic?.events ?? [])
          .filter(
            (e) => !events.some((output) => output.sourceEventId === e.id),
          )
          .map((e) => e.id)
      : [],
    numericChanges:
      originalNumbers.join("|") === finalNumbers.join("|")
        ? null
        : { raw: originalNumbers, normalized: finalNumbers },
  };
}
