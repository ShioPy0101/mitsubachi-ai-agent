import { z } from "zod";
import { announcementCategories } from "../railway/types";
import { stationMentionRoles } from "./service";

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

export const StationMentionSchema = z.object({
  text: z.string().min(1),
  start: z.number().int().nonnegative().nullable(),
  end: z.number().int().nonnegative().nullable(),
  role: z.enum(stationMentionRoles),
  sequenceId: z.number().int().positive().nullable(),
});

export const GeminiAnalysisSchema = TransitAnnouncementSchema.omit({ normalizedTranscription: true }).extend({
  mentions: z.array(StationMentionSchema),
});

export const GeminiNormalizationSchema = z.object({
  normalizedTranscription: z.string().trim().min(1),
  entities: z.array(z.object({
    text: z.string().trim().min(1),
    kind: z.enum(["station", "line", "train_name", "train_type", "destination", "other_proper_noun"]),
    sourceText: z.string().trim().min(1).nullable(),
  })),
});
export const GeminiResponseSchema = z
  .object({
    promptFeedback: z
      .object({
        blockReason: z.string().optional(),
        safetyRatings: z
          .array(
            z.object({
              category: z.string(),
              probability: z.string().optional(),
              blocked: z.boolean().optional().default(false),
            }),
          )
          .optional(),
      })
      .optional(),

    candidates: z
      .array(
        z
          .object({
            content: z
              .object({
                parts: z
                  .array(
                    z
                      .object({
                        text: z.string().optional(),
                      })
                      .passthrough(),
                  )
                  .optional(),

                role: z.string().optional(),
              })
              .optional(),

            finishReason: z.string().optional(),
            finishMessage: z.string().optional(),

            safetyRatings: z
              .array(
                z.object({
                  category: z.string(),
                  probability: z.string().optional(),
                  blocked: z.boolean().optional().default(false),
                }),
              )
              .optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export const transitAnnouncementJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "isTransitAnnouncement",
    "normalizedTranscription",
    "station",
    "line",
    "trainType",
    "trainName",
    "trainNumber",
    "destination",
    "departureTime",
    "arrivalTime",
    "platform",
    "nextStation",
    "category",
    "summary",
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

const metadataProperties = {
  isTransitAnnouncement: { type: "boolean" },
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
} as const;

export const geminiAnalysisJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "isTransitAnnouncement",
    "mentions",
    "station",
    "line",
    "trainType",
    "trainName",
    "trainNumber",
    "destination",
    "departureTime",
    "arrivalTime",
    "platform",
    "nextStation",
    "category",
    "summary",
  ],
  properties: {
    ...metadataProperties,
    mentions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "start", "end", "role", "sequenceId"],
        properties: {
          text: { type: "string", minLength: 1 },
          start: { type: ["integer", "null"], minimum: 0 },
          end: { type: ["integer", "null"], minimum: 0 },
          role: { type: "string", enum: [...stationMentionRoles] },
          sequenceId: { type: ["integer", "null"], minimum: 1 },
        },
      },
    },
  },
} as const;

export const geminiNormalizationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["normalizedTranscription", "entities"],
  properties: {
    normalizedTranscription: { type: "string", minLength: 1 },
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "kind", "sourceText"],
        properties: {
          text: { type: "string", minLength: 1 },
          kind: {
            type: "string",
            enum: ["station", "line", "train_name", "train_type", "destination", "other_proper_noun"],
          },
          sourceText: { type: ["string", "null"], minLength: 1 },
        },
      },
    },
  },
} as const;
