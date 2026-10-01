import type { GeminiNormalizationExtraction } from "../metadata/gemini";
import type { AnnouncementAnalysis } from "../metadata/service";
import { generateRailwayFilename } from "../railway/filename";
import type { RailwayAnnouncementMetadata } from "../railway/types";
import type { StationCorrectionResult } from "../stations/correction-engine";
import { resolveStation } from "../stations/resolver";

const stationValue = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/(?:駅|行き|ゆき|方面)$/u, "")
    .trim();
export function assembleResult(
  analysis: AnnouncementAnalysis,
  correction: StationCorrectionResult,
  normalization: GeminiNormalizationExtraction,
  originalFilename: string,
) {
  const resolution = resolveStation(
    correction.candidates,
    analysis.metadata.station,
  );
  const metadata: RailwayAnnouncementMetadata = {
    ...analysis.metadata,
    station: resolution.stationName,
  };
  const changed = new Set<string>();
  for (const entity of normalization.entities) {
    const mention = analysis.mentions.find(
      (m) => m.id === entity.sourceMentionId,
    );
    if (
      !mention ||
      (entity.kind !== "station" && entity.kind !== "destination")
    )
      continue;
    const field =
      mention.role === "destination"
        ? "destination"
        : mention.role === "next_stop"
          ? "nextStation"
          : null;
    if (
      field &&
      (analysis.mentions.filter((m) => m.role === mention.role).length === 1 ||
        stationValue(metadata[field] ?? "") === stationValue(mention.text))
    )
      metadata[field] = entity.text;
    if (entity.text !== entity.sourceText && mention.id)
      changed.add(mention.id);
  }
  correction.funnel.correctedMentions = changed.size;
  // Reasons describe actual output, not just whether reconciliation bound a candidate.
  correction.unresolvedMentions = analysis.mentions
    .filter((m) => !changed.has(m.id ?? ""))
    .flatMap((mention) => {
      const evidence = correction.mentionEvidence.find(
        (e) => e.mention.id === mention.id,
      );
      if (
        !evidence ||
        evidence.candidates.some(
          (c) =>
            c.station.name === mention.text &&
            Math.max(c.nameSimilarity, c.kanaSimilarity) === 1,
        )
      )
        return [];
      const previous = correction.unresolvedMentions.find(
        (u) => u.mentionId === mention.id,
      );
      return [
        {
          mentionId: mention.id ?? `${mention.start}:${mention.end}`,
          reason:
            normalization.normalizationObservation.outcome === "generated"
              ? (previous?.reason ?? ("normalization_skipped" as const))
              : ("normalization_skipped" as const),
        },
      ];
    });
  correction.funnel.unresolvedMentions = correction.unresolvedMentions.length;
  return {
    resolution,
    metadata,
    filename: generateRailwayFilename(metadata, originalFilename),
  };
}
