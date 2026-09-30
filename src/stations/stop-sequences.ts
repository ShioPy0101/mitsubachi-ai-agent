import type { StationMention } from "../metadata/service";

export type StopSequence = { id: number; mentions: StationMention[] };

export function groupStopSequences(mentions: readonly StationMention[]): StopSequence[] {
  const groups = new Map<number, StationMention[]>();
  for (const mention of mentions) {
    if (mention.sequenceId === null) continue;
    if (mention.role !== "stop" && mention.role !== "service_change_point") continue;
    const group = groups.get(mention.sequenceId) ?? [];
    group.push(mention);
    groups.set(mention.sequenceId, group);
  }
  return [...groups]
    .sort(([left], [right]) => left - right)
    .map(([id, sequenceMentions]) => ({ id, mentions: sequenceMentions }));
}
