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
  phoneticHint: z.string().trim().min(1).nullable().optional().default(null),
  start: z.number().int().nonnegative().nullable(),
  end: z.number().int().nonnegative().nullable(),
  role: z.enum(stationMentionRoles),
  sequenceId: z.number().int().positive().nullable(),
});

export const GeminiAnalysisSchema = TransitAnnouncementSchema.omit({ normalizedTranscription: true }).extend({
  mentions: z.array(StationMentionSchema),
});

export const normalizedSegmentQualities = ["normal", "corrected", "uncertain", "unintelligible"] as const;

export const GeminiNormalizationSchema = z.object({
  segments: z.array(z.object({
    segmentId: z.number().int().nonnegative(),
    sourceText: z.string().min(1),
    normalizedText: z.string().trim().min(1).nullable(),
    language: z.string().trim().min(1).nullable(),
    quality: z.enum(normalizedSegmentQualities),
  }).superRefine((segment, context) => {
    if ((segment.quality === "unintelligible") !== (segment.normalizedText === null)) {
      context.addIssue({
        code: "custom",
        message: "normalizedText must be null exactly when quality is unintelligible",
      });
    }
  })),
  entities: z.array(z.object({
    text: z.string().trim().min(1),
    kind: z.enum(["station", "line", "train_name", "train_type", "destination", "other_proper_noun"]),
    sourceText: z.string().trim().min(1).nullable(),
    segmentId: z.number().int().nonnegative(),
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
        required: ["text", "phoneticHint", "start", "end", "role", "sequenceId"],
        properties: {
          text: { type: "string", minLength: 1 },
          phoneticHint: { type: ["string", "null"], minLength: 1 },
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
  required: ["segments", "entities"],
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["segmentId", "sourceText", "normalizedText", "language", "quality"],
        properties: {
          segmentId: { type: "integer", minimum: 0 },
          sourceText: { type: "string", minLength: 1 },
          normalizedText: { type: ["string", "null"], minLength: 1 },
          language: { type: ["string", "null"], minLength: 1 },
          quality: { type: "string", enum: [...normalizedSegmentQualities] },
        },
      },
    },
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "kind", "sourceText", "segmentId"],
        properties: {
          text: { type: "string", minLength: 1 },
          kind: {
            type: "string",
            enum: ["station", "line", "train_name", "train_type", "destination", "other_proper_noun"],
          },
          sourceText: { type: ["string", "null"], minLength: 1 },
          segmentId: { type: "integer", minimum: 0 },
        },
      },
    },
  },
} as const;
