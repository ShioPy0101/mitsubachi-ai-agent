import type { AnnouncementAnalysis, StationMention } from "../metadata/service";
import type { NormalizedEntity } from "../metadata/gemini";
import type { RailwayAnnouncementMetadata } from "./types";

const stationValue = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/(?:駅|行き|ゆき|方面)$/u, "")
    .trim();

export function sourceMentionForEntity(
  mentions: readonly StationMention[],
  entity: NormalizedEntity,
): StationMention | undefined {
  if (entity.kind !== "station" && entity.kind !== "destination") return;
  if (entity.sourceMentionId)
    return mentions.find((m) => m.id === entity.sourceMentionId);
  if (!entity.sourceText) return;
  const matches = mentions.filter(
    (m) => stationValue(m.text) === stationValue(entity.sourceText!),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

// Provider final metadata is authoritative. Legacy responses can still map
// explicitly linked corrections into draft fields; no transcript substring
// guessing or additional model call is needed.
export function assembleNormalizedMetadata(
  analysis: AnnouncementAnalysis,
  finalMetadata: Partial<RailwayAnnouncementMetadata> | undefined,
  entities: readonly NormalizedEntity[],
  resolvedStation: string | null,
): RailwayAnnouncementMetadata {
  const result: RailwayAnnouncementMetadata = {
    ...analysis.metadata,
    station: resolvedStation,
    ...finalMetadata,
  };
  const provided = (field: keyof RailwayAnnouncementMetadata) =>
    Object.prototype.hasOwnProperty.call(finalMetadata ?? {}, field);
  const replacements = new Map<string, Set<string>>();
  for (const entity of entities) {
    const mention = sourceMentionForEntity(analysis.mentions, entity);
    if (!mention) continue;
    for (const field of ["destination", "nextStation", "station"] as const) {
      if (provided(field)) continue;
      const roleField =
        mention.role === "destination"
          ? "destination"
          : mention.role === "next_stop"
            ? "nextStation"
            : null;
      const uniqueRole =
        analysis.mentions.filter((m) => m.role === mention.role).length === 1;
      const current = result[field];
      const draft = analysis.metadata[field];
      if (
        (field === roleField && uniqueRole) ||
        (current !== null &&
          stationValue(current) === stationValue(mention.text)) ||
        (draft !== null && stationValue(draft) === stationValue(mention.text))
      )
        result[field] = entity.text;
    }
    const targets = replacements.get(mention.text) ?? new Set<string>();
    targets.add(entity.text);
    replacements.set(mention.text, targets);
  }
  if (!provided("summary") && result.summary) {
    // One-pass substitution prevents overlapping names or target/source chains
    // from causing cascading changes to the draft summary.
    const sources = [...replacements.keys()]
      .filter((s) => replacements.get(s)!.size === 1)
      .sort((a, b) => b.length - a.length);
    if (sources.length) {
      const pattern = new RegExp(
        sources.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
        "gu",
      );
      result.summary = result.summary.replace(
        pattern,
        (source) => [...replacements.get(source)!][0]!,
      );
    }
  }
  return result;
}
