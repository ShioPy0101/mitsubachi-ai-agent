import { z } from "zod";
import { announcementCategories } from "../railway/types";

const TimeSchema = z.string().regex(/^\d{2}:\d{2}$/u);

export const RailwayAnnouncementSchema = z.object({
  normalizedTranscription: z.string().trim().min(1),
  station: z.string().nullable(),
  line: z.string().nullable(),
  trainType: z.string().nullable(),
  trainName: z.string().nullable(),
  trainNumber: z.string().nullable(),
  destination: z.string().nullable(),
  departureTime: TimeSchema.nullable(),
  arrivalTime: TimeSchema.nullable(),
  platform: z.string().nullable(),
  nextStation: z.string().nullable(),
  category: z.enum(announcementCategories),
  summary: z.string().max(30).nullable(),
});

export type ParsedRailwayAnnouncement = z.output<typeof RailwayAnnouncementSchema>;

export const GeminiResponseSchema = z.object({
  candidates: z.array(
    z.object({
      content: z.object({
        parts: z.array(z.object({ text: z.string() })).min(1),
      }),
    }),
  ).min(1),
});

export const railwayAnnouncementJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "normalizedTranscription", "station", "line", "trainType", "trainName", "trainNumber", "destination",
    "departureTime", "arrivalTime", "platform", "nextStation", "category", "summary",
  ],
  properties: {
    normalizedTranscription: { type: "string", minLength: 1 },
    station: { type: ["string", "null"] },
    line: { type: ["string", "null"] },
    trainType: { type: ["string", "null"] },
    trainName: { type: ["string", "null"] },
    trainNumber: { type: ["string", "null"] },
    destination: { type: ["string", "null"] },
    departureTime: { type: ["string", "null"], pattern: "^\\d{2}:\\d{2}$" },
    arrivalTime: { type: ["string", "null"], pattern: "^\\d{2}:\\d{2}$" },
    platform: { type: ["string", "null"] },
    nextStation: { type: ["string", "null"] },
    category: { type: "string", enum: [...announcementCategories] },
    summary: { type: ["string", "null"], maxLength: 30 },
  },
} as const;
