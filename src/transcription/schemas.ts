import { z } from "zod";

export const WorkersAiWhisperResponseSchema = z.object({
  transcription_info: z.object({ language: z.string().optional() }).optional(),
  text: z.string(),
  segments: z
    .array(
      z.object({
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
        text: z.string(),
      }),
    )
    .optional(),
});
