import type { CorrectionSequence } from "./correction-engine";
import { lexicalSimilarities } from "./candidate-service";
import type { CrossLanguageEvidence, Station } from "./types";

// Group IDs must denote corresponding announcements, not merely the same line.
// Peer stop lists supply soft candidates only; they never create new mentions
// or bypass lexical/route requirements for deterministic binding.
export function multilingualSupport(
  target: CorrectionSequence,
  sequences: readonly CorrectionSequence[],
): {
  stations: (Station | null)[];
  evidence: (CrossLanguageEvidence | null)[];
} | null {
  if (target.role !== "stops" || target.mentions.length < 2) return null;
  const group = target.mentions[0]?.equivalentEventGroupId;
  const language = target.mentions[0]?.language;
  if (
    !group ||
    !language ||
    language === "unknown" ||
    !target.mentions.every(
      (m) => m.equivalentEventGroupId === group && m.language === language,
    )
  )
    return null;
  for (const peer of sequences) {
    if (
      peer.id === target.id ||
      peer.role !== "stops" ||
      peer.mentions.length !== target.mentions.length
    )
      continue;
    const peerLanguage = peer.mentions[0]?.language;
    if (
      !peerLanguage ||
      peerLanguage === "unknown" ||
      peerLanguage === language ||
      !peer.mentions.every(
        (m) =>
          m.equivalentEventGroupId === group && m.language === peerLanguage,
      )
    )
      continue;
    const route = peer.stationSearch.routeCandidates[0];
    if (
      !route ||
      route.score < 0.8 ||
      route.orderConsistency !== 1 ||
      (route.hardAnchorViolations ?? 0) > 0
    )
      continue;
    const matches = route.mentionMatches;
    if (
      !matches ||
      matches.length !== target.mentions.length ||
      matches.some((m) => m.lexicalSimilarity < 0.8)
    )
      continue;
    const similarities = matches.map((match, i) =>
      lexicalSimilarities(
        target.mentions[i]!.text,
        match.station,
        target.mentions[i]!.phoneticHint,
      ),
    );
    // At least two independent correspondences establish ordered stop-list alignment.
    if (similarities.filter((s) => s.lexicalSimilarity >= 0.5).length < 2)
      continue;
    if (
      target.mentions.some((mention, i) => {
        const exact =
          target.stationSearch.mentionCandidates[i]?.filter(
            (c) => c.nameSimilarity === 1 || c.kanaSimilarity === 1,
          ) ?? [];
        return (
          exact.length > 0 &&
          !exact.some(
            (c) =>
              c.station.id === matches[i]!.station.id ||
              c.station.name === matches[i]!.station.name,
          )
        );
      })
    )
      continue;
    return {
      stations: matches.map((m, i) =>
        similarities[i]!.lexicalSimilarity >= 0.3 ? m.station : null,
      ),
      evidence: matches.map((m, i) =>
        similarities[i]!.lexicalSimilarity >= 0.3
          ? {
              groupId: group,
              peerMentionId: peer.mentions[i]!.id ?? `${peer.id}:${i}`,
              peerLanguage,
              peerSequenceId: peer.id,
              stationId: m.station.id,
              routeScore: route.score,
            }
          : null,
      ),
    };
  }
  return null;
}
