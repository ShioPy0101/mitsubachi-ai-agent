import type { SequenceRole, StationMention } from "../metadata/service";

export type StationSequence = {
  id: number;
  role: SequenceRole;
  mentions: StationMention[];
  contextMentions: StationMention[];
};

function sequenceRole(mentions: readonly StationMention[]): SequenceRole {
  const roles = new Set(mentions.map(({ role }) => role));
  if ([...roles].every((role) => role === "stop" || role === "service_change_point" || role === "next_stop")) {
    return "stops";
  }
  if ([...roles].every((role) => role === "direction")) return "direction";
  if ([...roles].every((role) => role === "destination")) return "destination";
  return "unknown";
}

function mentionSequenceRole(mention: StationMention): SequenceRole {
  if (mention.role === "stop" || mention.role === "service_change_point" || mention.role === "next_stop") {
    return "stops";
  }
  if (mention.role === "direction") return "direction";
  if (mention.role === "destination") return "destination";
  return "unknown";
}

function nearbyDirectionRuns(mentions: readonly StationMention[], firstSyntheticId: number): StationSequence[] {
  const directions = mentions.filter(({ role, sequenceId }) => role === "direction" && sequenceId === null);
  const sequences: StationSequence[] = [];
  let run: StationMention[] = [];
  let nextId = firstSyntheticId;
  const flush = (): void => {
    if (run.length >= 2) {
      sequences.push({ id: nextId, role: "direction", mentions: run, contextMentions: [] });
      nextId += 1;
    }
    run = [];
  };
  for (const mention of directions) {
    const previous = run.at(-1);
    const gap = previous?.end != null && mention.start !== null ? mention.start - previous.end : 0;
    if (previous !== undefined && gap > 8) flush();
    run.push(mention);
  }
  flush();
  return sequences;
}

function nearestDestinationAfter(
  sequence: StationSequence,
  destinations: readonly StationMention[],
): StationMention | null {
  const end = sequence.mentions.at(-1)?.end;
  if (end == null) return destinations[0] ?? null;
  return destinations
    .filter(({ start }) => start !== null && start >= end && start - end <= 160)
    .sort((left, right) => (left.start ?? 0) - (right.start ?? 0))[0] ?? null;
}

export function groupStationSequences(mentions: readonly StationMention[]): StationSequence[] {
  const groups = new Map<number, StationMention[]>();
  let maximumId = 0;
  for (const mention of mentions) {
    if (mention.sequenceId === null) continue;
    maximumId = Math.max(maximumId, mention.sequenceId);
    const group = groups.get(mention.sequenceId) ?? [];
    group.push(mention);
    groups.set(mention.sequenceId, group);
  }
  let nextExplicitId = maximumId + 1;
  const explicit = [...groups]
    .sort(([left], [right]) => left - right)
    .flatMap(([id, sequenceMentions]): StationSequence[] => {
      const role = sequenceRole(sequenceMentions);
      if (role !== "unknown") return [{ id, role, mentions: sequenceMentions, contextMentions: [] }];
      const partitions = new Map<SequenceRole, StationMention[]>();
      for (const mention of sequenceMentions) {
        const mentionRole = mentionSequenceRole(mention);
        const values = partitions.get(mentionRole) ?? [];
        values.push(mention);
        partitions.set(mentionRole, values);
      }
      return [...partitions].map(([partitionRole, values], index) => ({
        id: index === 0 ? id : nextExplicitId++,
        role: partitionRole,
        mentions: values,
        contextMentions: [],
      }));
    });
  const inferredDirections = nearbyDirectionRuns(mentions, nextExplicitId);
  let nextId = Math.max(
    maximumId,
    ...explicit.map(({ id }) => id),
    ...inferredDirections.map(({ id }) => id),
    0,
  ) + 1;
  const assigned = new Set(explicit.flatMap(({ mentions: values }) => values));
  for (const sequence of inferredDirections) for (const mention of sequence.mentions) assigned.add(mention);
  const destinations = mentions.filter(({ role }) => role === "destination");
  const standaloneDestinations = destinations
    .filter((mention) => !assigned.has(mention))
    .map((mention): StationSequence => ({
      id: nextId++, role: "destination", mentions: [mention], contextMentions: [],
    }));
  const sequences = [...explicit, ...inferredDirections, ...standaloneDestinations];
  for (const sequence of sequences) {
    if (sequence.role !== "direction") continue;
    const destination = nearestDestinationAfter(sequence, destinations);
    if (destination !== null && !sequence.mentions.includes(destination)) sequence.contextMentions.push(destination);
  }
  return sequences.sort((left, right) => left.id - right.id);
}

export function groupStopSequences(mentions: readonly StationMention[]): StationSequence[] {
  return groupStationSequences(mentions).filter(({ role }) => role === "stops");
}
