import { z } from "zod";
import { announcementCategories } from "../railway/types";

const TimeSchema = z.string().regex(/^\d{2}:\d{2}$/u);

export const TransitAnnouncementSchema = z.object({
  isTransitAnnouncement: z.boolean(),
  normalizedTranscription: z.string().trim().min(1),
  station: z.null(),
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

export type ParsedTransitAnnouncement = z.output<typeof TransitAnnouncementSchema>;

export const GeminiResponseSchema = z.object({
  promptFeedback: z.object({
    blockReason: z.string().optional(),
    safetyRatings: z.array(z.object({
      category: z.string(),
      probability: z.string().optional(),
      blocked: z.boolean().optional().default(false),
    })).optional(),
  }).optional(),
  candidates: z.array(
    z.object({
      content: z.object({
        parts: z.array(z.object({ text: z.string() })).min(1),
      }).optional(),
      finishReason: z.string().optional(),
      safetyRatings: z.array(z.object({
        category: z.string(),
        probability: z.string().optional(),
        blocked: z.boolean().optional().default(false),
      })).optional(),
    }),
  ).min(1).default([]),
});

export const transitAnnouncementJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "isTransitAnnouncement", "normalizedTranscription", "station", "line", "trainType", "trainName", "trainNumber", "destination",
    "departureTime", "arrivalTime", "platform", "nextStation", "category", "summary",
  ],
  properties: {
    isTransitAnnouncement: { type: "boolean" },
    normalizedTranscription: { type: "string", minLength: 1 },
    station: { type: "null" },
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
