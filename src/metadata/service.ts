import type { RailwayAnnouncementMetadata } from "../railway/types";

export const stationMentionRoles = [
  "destination",
  "direction",
  "stop",
  "next_stop",
  "transfer",
  "service_change_point",
  "unknown",
] as const;

export type StationMentionRole = (typeof stationMentionRoles)[number];

export const sequenceRoles = ["stops", "direction", "destination", "unknown"] as const;
export type SequenceRole = (typeof sequenceRoles)[number];

export type StationMention = {
  text: string;
  reading?: string | null;
  start: number | null;
  end: number | null;
  role: StationMentionRole;
  sequenceId: number | null;
};

export type AnnouncementAnalysis = {
  isTransitAnnouncement: boolean;
  mentions: StationMention[];
  metadata: RailwayAnnouncementMetadata;
};

export type MetadataResult = {
  isTransitAnnouncement: boolean;
  normalizedTranscription: string;
  metadata: RailwayAnnouncementMetadata;
};
