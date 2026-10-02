import type { GeminiNormalizationExtraction } from "../metadata/gemini";
import type { AnnouncementAnalysis } from "../metadata/service";
import { generateRailwayFilename } from "../railway/filename";
import {
  assembleNormalizedMetadata,
  sourceMentionForEntity,
} from "../railway/result-metadata";
import type { StationCorrectionResult } from "../stations/correction-engine";
import { resolveStation } from "../stations/resolver";

export function assembleResult(
  analysis: AnnouncementAnalysis,
  correction: StationCorrectionResult,
  normalization: GeminiNormalizationExtraction,
  originalFilename: string,
) {
  const resolution = resolveStation(
    correction.candidates,
    normalization.metadata &&
      Object.prototype.hasOwnProperty.call(normalization.metadata, "station")
      ? (normalization.metadata.station ?? null)
      : analysis.metadata.station,
  );
  const metadata = assembleNormalizedMetadata(
    analysis,
    normalization.metadata,
    normalization.entities,
    resolution.stationName,
  );
  const changed = new Set<string>();
  for (const entity of normalization.entities) {
    const mention = sourceMentionForEntity(analysis.mentions, entity);
    if (
      !mention ||
      (entity.kind !== "station" && entity.kind !== "destination")
    )
      continue;
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
