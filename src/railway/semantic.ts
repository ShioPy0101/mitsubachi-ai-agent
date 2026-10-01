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
export type SpeechSourceSegment = {
  startSec: number;
  endSec: number;
  text: string;
};
export type AnnouncementSourceSegment = {
  id: string;
  text: string;
  sourceSpan: SourceSpan | null;
  sourceTimeRange?: { startSec: number; endSec: number };
};
export type RailwayAnnouncement = {
  readonly rawTranscription: string;
  events: RailwayAnnouncementEvent[];
  sourceSegments?: AnnouncementSourceSegment[];
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
// Provider event spans are approximate annotations, never source split boundaries.
function sourceSegmentsFor(
  raw: string,
  speech: readonly SpeechSourceSegment[],
): AnnouncementSourceSegment[] {
  if (speech.length) {
    let cursor = 0;
    return speech.map((segment, index) => {
      const text = segment.text.trim();
      const start = text ? raw.indexOf(text, cursor) : -1;
      const sourceSpan = start < 0 ? null : { start, end: start + text.length };
      if (sourceSpan) cursor = sourceSpan.end;
      return {
        id: `speech-segment:${index}`,
        text: segment.text,
        sourceSpan,
        sourceTimeRange: { startSec: segment.startSec, endSec: segment.endSec },
      };
    });
  }
  // Saved text-only fixtures have no speech boundaries. Use source punctuation,
  // independently of model offsets, and keep raw unchanged.
  const boundaries = [...raw.matchAll(/[。!?！？\n]+|(?<!\d)\.(?=\s|$)/gu)].map(
    (m) => m.index! + m[0].length,
  );
  if (boundaries.at(-1) !== raw.length) boundaries.push(raw.length);
  let start = 0;
  return boundaries.flatMap((end) => {
    const span = { start, end };
    start = end;
    return span.start === end
      ? []
      : [
          {
            id: `text-segment:${span.start}:${end}`,
            text: raw.slice(span.start, end),
            sourceSpan: span,
          },
        ];
  });
}
export function buildSemanticRepresentation(
  rawTranscription: string,
  mentions: readonly StationMention[],
  proposals: readonly SemanticEventProposal[] = [],
  speechSegments: readonly SpeechSourceSegment[] = [],
): RailwayAnnouncement {
  const sourceSegments = sourceSegmentsFor(rawTranscription, speechSegments);
  const events = sourceSegments.flatMap(
    (source): RailwayAnnouncementEvent[] => {
      const span = source.sourceSpan ?? {
        start: 0,
        end: rawTranscription.length,
      };
      const annotations = source.sourceSpan
        ? proposals.filter(
            (p) => p.sourceStart < span.end && p.sourceEnd > span.start,
          )
        : [];
      // Multiple annotations may share one complete speech segment. They do not
      // create sub-segments or new slices of the original text.
      return (annotations.length ? annotations : [undefined]).map(
        (proposal, index) => ({
          id: `event:${source.id}:${index}`,
          kind: proposal?.kind ?? eventKind(source.text),
          language:
            proposal?.language === undefined || proposal.language === "unknown"
              ? announcementLanguage(source.text)
              : proposal.language,
          sourceSpan: span,
          sourceSegmentIds: [source.id],
          sourceOccurrenceCount: 1,
          ...(source.sourceTimeRange
            ? { sourceTimeRange: source.sourceTimeRange }
            : {}),
          entities: mentions
            .filter(
              (m) =>
                source.sourceSpan &&
                m.start !== null &&
                m.end !== null &&
                m.start >= span.start &&
                m.end <= span.end,
            )
            .map((m) => ({
              id: `entity:${m.id}`,
              kind: "station" as const,
              text: m.text,
              sourceSpan: { start: m.start!, end: m.end! },
              ...(m.id ? { sourceMentionId: m.id } : {}),
            })),
          confidence: proposal?.confidence ?? 0.5,
          semanticContext: proposal ?? {},
          correctionEvidence: [],
          equivalentEventGroupId: proposal?.equivalentEventGroupId ?? null,
        }),
      );
    },
  );
  return { rawTranscription, sourceSegments, events };
}

export function attachSpeechSegmentProvenance(
  representation: RailwayAnnouncement,
  segments: readonly SpeechSourceSegment[],
): RailwayAnnouncement {
  if (!segments.length) return representation;
  const proposals = representation.events
    .map((e) => e.semanticContext)
    .filter(
      (p): p is SemanticEventProposal =>
        typeof p.sourceStart === "number" &&
        typeof p.sourceEnd === "number" &&
        p.kind !== undefined,
    );
  const uniqueProposals = [
    ...new Map(
      proposals.map((p) => [
        `${p.sourceStart}:${p.sourceEnd}:${p.kind}:${p.language}`,
        p,
      ]),
    ).values(),
  ];
  const mentions = representation.events
    .flatMap((e) => e.entities)
    .filter((e) => e.kind === "station")
    .map((e): StationMention => ({
      id: e.sourceMentionId ?? e.id,
      text: e.text,
      start: e.sourceSpan.start,
      end: e.sourceSpan.end,
      role: "unknown",
      sequenceId: null,
      phoneticHint: null,
    }));
  return buildSemanticRepresentation(
    representation.rawTranscription,
    mentions,
    uniqueProposals,
    segments,
  );
}
