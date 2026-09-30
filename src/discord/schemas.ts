import { z } from "zod";

export const DiscordAttachmentSchema = z
  .object({
    id: z.string().min(1),
    filename: z.string().min(1),
    size: z.number().int().nonnegative(),
    url: z.url(),
    proxy_url: z.url().optional(),
    content_type: z.string().optional(),
    duration_secs: z.number().nonnegative().optional(),
  })
  .transform((value) => ({
    id: value.id,
    filename: value.filename,
    size: value.size,
    url: value.url,
    contentType: value.content_type ?? null,
    durationSecs: value.duration_secs ?? null,
  }));

export type DiscordAttachment = z.output<typeof DiscordAttachmentSchema>;

const InteractionOptionSchema = z.object({
  name: z.string(),
  type: z.number().int(),
  value: z.string().optional(),
  options: z.array(z.object({
    name: z.string(),
    type: z.number().int(),
    value: z.string(),
  })).optional(),
});

export const DiscordInteractionSchema = z.object({
  id: z.string(),
  application_id: z.string(),
  type: z.number().int(),
  token: z.string(),
  guild_id: z.string().optional(),
  channel_id: z.string().optional(),
  member: z.object({
    user: z.object({ id: z.string() }),
    permissions: z.string().optional(),
  }).optional(),
  user: z.object({ id: z.string() }).optional(),
  data: z
    .object({
      name: z.string().optional(),
      custom_id: z.string().optional(),
      options: z.array(InteractionOptionSchema).optional(),
      resolved: z
        .object({
          attachments: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    })
    .optional(),
});

export type DiscordInteraction = z.output<typeof DiscordInteractionSchema>;
