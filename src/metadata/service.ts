import type { RailwayAnnouncementMetadata } from "../railway/types";
import type { StationCandidate } from "../stations/types";

export type MetadataResult = {
  isTransitAnnouncement: boolean;
  normalizedTranscription: string;
  metadata: RailwayAnnouncementMetadata;
};

export interface MetadataService {
  extract(transcription: string, stationCandidates: readonly StationCandidate[]): Promise<MetadataResult>;
}
