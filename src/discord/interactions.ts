import { DiscordAttachmentSchema, DiscordInteractionSchema, type DiscordAttachment } from "./schemas";

export const PLATFORM_COMMAND_NAME = "platform-ai-agent";
export const SEARCH_COMMAND_NAME = "platform-search";
const attachmentOptionType = 11;

export type ParsedShioCommand = {
  interactionId: string;
  interactionToken: string;
  guildId: string | null;
  channelId: string | null;
  attachment: DiscordAttachment;
};

export type CommandParseResult =
  | { ok: true; value: ParsedShioCommand }
  | { ok: false; error: string };

export function parseShioCommand(input: unknown): CommandParseResult {
  const parsed = DiscordInteractionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Interactionの形式が不正です。" };
  const interaction = parsed.data;
  if (interaction.type !== 2 || interaction.data?.name !== PLATFORM_COMMAND_NAME) {
    return { ok: false, error: "未対応のコマンドです。" };
  }
  const option = interaction.data.options?.find(
    (candidate) => candidate.name === "audio" && candidate.type === attachmentOptionType,
  );
  if (option === undefined) return { ok: false, error: "audio添付は必須です。" };
  const attachmentInput = interaction.data.resolved?.attachments?.[option.value];
  const attachment = DiscordAttachmentSchema.safeParse(attachmentInput);
  if (!attachment.success) return { ok: false, error: "audio添付を読み取れませんでした。" };
  return {
    ok: true,
    value: {
      interactionId: interaction.id,
      interactionToken: interaction.token,
      guildId: interaction.guild_id ?? null,
      channelId: interaction.channel_id ?? null,
      attachment: attachment.data,
    },
  };
}

export const deferredEphemeralResponse = (): Response =>
  Response.json({ type: 5, data: { flags: 64 } });

export const ephemeralErrorResponse = (content: string): Response =>
  Response.json({ type: 4, data: { content, flags: 64 } });
