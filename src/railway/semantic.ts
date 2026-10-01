import type { StationMention } from "../metadata/service";
import { railwayIndexes } from "../stations/static-data";
const stationNames = [...railwayIndexes.byName.keys()]
  .filter((name) => name.length >= 2)
  .sort((a, b) => b.length - a.length || a.localeCompare(b));

export type AnnouncementLanguage = "ja" | "en" | "unknown";
export const announcementEventKinds = [
  "DepartureAnnouncement",
  "ArrivalAnnouncement",
  "StopListAnnouncement",
  "FormationAnnouncement",
  "SeatInformation",
  "TransferInformation",
  "DelayAnnouncement",
  "DoorClosingAnnouncement",
  "OtherAnnouncement",
] as const;
export type AnnouncementEventKind = (typeof announcementEventKinds)[number];
export type SemanticEventProposal = {
  kind: AnnouncementEventKind;
  sourceStart: number;
  sourceEnd: number;
  language: AnnouncementLanguage;
  trainType: string | null;
  destination: string | null;
  line: string | null;
  platform: string | null;
  formation: string | null;
  seatInformation: string | null;
  transferInformation: string | null;
  delayInformation: string | null;
  confidence: number;
  equivalentEventGroupId: string | null;
};

export type SourceSpan = { start: number; end: number };
export type FactualEntity = {
  id: string;
  kind: "station" | "number" | "operation";
  text: string;
  sourceSpan: SourceSpan;
  sourceMentionId?: string;
};
export type RailwayAnnouncementEvent = {
  id: string;
  kind: AnnouncementEventKind;
  language: AnnouncementLanguage;
  sourceSpan: SourceSpan;
  sourceSegmentIds: string[];
  sourceOccurrenceCount: number;
  sourceTimeRange?: { startSec: number; endSec: number };
  entities: FactualEntity[];
  confidence: number;
  semanticContext: Partial<SemanticEventProposal>;
  correctionEvidence: string[];
  equivalentEventGroupId: string | null;
};
export type RailwayAnnouncement = {
  readonly rawTranscription: string;
  events: RailwayAnnouncementEvent[];
};
export type NormalizedAnnouncementEvent = {
  sourceEventId: string;
  language: AnnouncementLanguage;
  text: string;
};
export const announcementLanguage = (text: string): AnnouncementLanguage =>
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
    ? "ja"
    : /[a-z]/i.test(text)
      ? "en"
      : "unknown";

// Longest-match scan is local static data, never sent to a language model.
// One-character station names require explicit mentions to avoid matching grammar.
const namesByFirst = new Map<string, string[]>();
for (const name of stationNames) {
  const first = name[0]!;
  const list = namesByFirst.get(first) ?? [];
  list.push(name);
  namesByFirst.set(first, list);
}
export function stationNameOccurrences(text: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < text.length; index++) {
    const match = namesByFirst
      .get(text[index]!)
      ?.find((name) => text.startsWith(name, index));
    if (match) {
      found.push(match);
      index += match.length - 1;
    }
  }
  return found;
}
function eventKind(text: string): AnnouncementEventKind {
  if (/乗換|乗り換え|transfer/iu.test(text)) return "TransferInformation";
  if (/遅延|遅れ|delay/iu.test(text)) return "DelayAnnouncement";
  if (/両|carriage|formation/iu.test(text)) return "FormationAnnouncement";
  if (/座席|指定席|seat/iu.test(text)) return "SeatInformation";
  if (/閉ま|closing/iu.test(text)) return "DoorClosingAnnouncement";
  if (/停車|stops|next stop/iu.test(text)) return "StopListAnnouncement";
  if (/到着|arriv/iu.test(text)) return "ArrivalAnnouncement";
  if (/発車|depart/iu.test(text)) return "DepartureAnnouncement";
  return "OtherAnnouncement";
}
// Deterministic source partitions ensure no provider can omit a language or occurrence.
export function buildSemanticRepresentation(
  rawTranscription: string,
  mentions: readonly StationMention[],
  proposals: readonly SemanticEventProposal[] = [],
): RailwayAnnouncement {
  const events: RailwayAnnouncementEvent[] = [];
  const boundaries = [
    ...rawTranscription.matchAll(/[。!?！？\n]+|(?<!\d)\.(?=\s|$)/gu),
  ].map((m) => m.index! + m[0].length);
  if (boundaries.at(-1) !== rawTranscription.length)
    boundaries.push(rawTranscription.length);
  const orderedBoundaries = [
    ...new Set([
      ...boundaries,
      ...proposals
        .flatMap((p) => [p.sourceStart, p.sourceEnd])
        .filter(
          (n) => Number.isInteger(n) && n > 0 && n <= rawTranscription.length,
        ),
    ]),
  ].sort((a, b) => a - b);
  let previousEnd = 0;
  for (const end of orderedBoundaries) {
    const start = previousEnd;
    previousEnd = end;
    const match = [rawTranscription.slice(start, end)];
    if (!match[0]) continue;
    const entities: FactualEntity[] = mentions
      .filter(
        (m) =>
          m.start !== null &&
          m.end !== null &&
          m.start >= start &&
          m.end <= end,
      )
      .map((m) => ({
        id: `entity:${m.id}`,
        kind: "station",
        text: m.text,
        sourceSpan: { start: m.start!, end: m.end! },
        ...(m.id ? { sourceMentionId: m.id } : {}),
      }));
    const proposal = proposals.find(
      (p) => p.sourceStart <= start && p.sourceEnd >= end,
    );
    events.push({
      id: `event:${start}:${end}`,
      kind: proposal?.kind ?? eventKind(match[0]),
      language: announcementLanguage(match[0]),
      sourceSpan: { start, end },
      sourceSegmentIds: [`text-segment:${start}:${end}`],
      sourceOccurrenceCount: 1,
      entities,
      confidence: proposal?.confidence ?? 0.5,
      semanticContext: proposal ?? {},
      correctionEvidence: [],
      equivalentEventGroupId: proposal?.equivalentEventGroupId ?? null,
    });
  }
  return { rawTranscription, events };
}

export function attachSpeechSegmentProvenance(
  representation: RailwayAnnouncement,
  segments: readonly { startSec: number; endSec: number; text: string }[],
): RailwayAnnouncement {
  let cursor = 0;
  const spans = segments.flatMap((segment, index) => {
    const text = segment.text.trim(),
      start = representation.rawTranscription.indexOf(text, cursor);
    if (!text || start < 0) return [];
    const end = start + text.length;
    cursor = end;
    return [{ ...segment, start, end, id: `speech-segment:${index}` }];
  });
  return {
    ...representation,
    events: representation.events.map((event) => {
      const sources = spans.filter(
        (s) => s.start < event.sourceSpan.end && s.end > event.sourceSpan.start,
      );
      return sources.length
        ? {
            ...event,
            sourceSegmentIds: sources.map((s) => s.id),
            sourceTimeRange: {
              startSec: Math.min(...sources.map((s) => s.startSec)),
              endSec: Math.max(...sources.map((s) => s.endSec)),
            },
          }
        : event;
    }),
  };
}
