export const announcementCategories = [
  "approaching",
  "arrival",
  "departure",
  "platform",
  "transfer",
  "stopping_pattern",
  "delay",
  "safety",
  "door_guidance",
  "general_information",
  "other",
] as const;

export type AnnouncementCategory = (typeof announcementCategories)[number];

export type RailwayAnnouncementMetadata = {
  station: string | null;
  line: string | null;
  trainType: string | null;
  trainName: string | null;
  trainNumber: string | null;
  destination: string | null;
  departureTime: string | null;
  arrivalTime: string | null;
  platform: string | null;
  nextStation: string | null;
  category: AnnouncementCategory;
  summary: string | null;
};
