import {
  DiscordAttachmentSchema,
  DiscordInteractionSchema,
  type DiscordAttachment,
} from "./schemas";

export const PLATFORM_COMMAND_NAME = "platform-ai-agent";
export const PLATFORM_ALLOW_COMMAND_NAME = "platform-ai-agent-allow";
export const PLATFORM_DENY_COMMAND_NAME = "platform-ai-agent-deny";
export const PLATFORM_DEMO_COMMAND_NAME = "platform-ai-agent-demo";
export const SEARCH_COMMAND_NAME = "platform-search";
const attachmentOptionType = 11;

export type ParsedAudioCommand = {
  kind: "audio";
  interactionId: string;
  interactionToken: string;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  attachment: DiscordAttachment;
};

export type ParsedAccessCommand = {
  kind: "access";
  action: "allow" | "deny";
  guildId: string | null;
  userId: string | null;
};

export type ParsedDemoCommand = Omit<ParsedAudioCommand, "kind"> & {
  kind: "demo";
};

export type PlatformCommandParseResult =
  | {
      ok: true;
      value: ParsedAudioCommand | ParsedAccessCommand | ParsedDemoCommand;
    }
  | { ok: false; error: string };

export function parsePlatformCommand(
  input: unknown,
): PlatformCommandParseResult {
  const parsed = DiscordInteractionSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: "Interactionの形式が不正です。" };
  const interaction = parsed.data;
  if (interaction.type !== 2 || interaction.data === undefined) {
    return { ok: false, error: "未対応のコマンドです。" };
  }
  if (
    interaction.data.name === PLATFORM_ALLOW_COMMAND_NAME ||
    interaction.data.name === PLATFORM_DENY_COMMAND_NAME
  ) {
    return {
      ok: true,
      value: {
        kind: "access",
        action:
          interaction.data.name === PLATFORM_ALLOW_COMMAND_NAME
            ? "allow"
            : "deny",
        guildId: interaction.guild_id ?? null,
        userId: interaction.member?.user.id ?? interaction.user?.id ?? null,
      },
    };
  }
  const isDemo = interaction.data.name === PLATFORM_DEMO_COMMAND_NAME;
  if (interaction.data.name !== PLATFORM_COMMAND_NAME && !isDemo) {
    return { ok: false, error: "未対応のコマンドです。" };
  }
  const option = interaction.data.options?.find(
    (candidate) =>
      candidate.name === "audio" &&
      candidate.type === attachmentOptionType &&
      candidate.value !== undefined,
  );
  if (option?.value === undefined)
    return { ok: false, error: "audio添付は必須です。" };
  const attachmentInput =
    interaction.data.resolved?.attachments?.[option.value];
  const attachment = DiscordAttachmentSchema.safeParse(attachmentInput);
  if (!attachment.success)
    return { ok: false, error: "audio添付を読み取れませんでした。" };
  return {
    ok: true,
    value: {
      kind: isDemo ? "demo" : "audio",
      interactionId: interaction.id,
      interactionToken: interaction.token,
      guildId: interaction.guild_id ?? null,
      channelId: interaction.channel_id ?? null,
      userId: interaction.member?.user.id ?? interaction.user?.id ?? null,
      attachment: attachment.data,
    },
  };
}

export const deferredResponse = (): Response => Response.json({ type: 5 });

export const ephemeralErrorResponse = (content: string): Response =>
  Response.json({ type: 4, data: { content, flags: 64 } });

export const ephemeralMessageResponse = ephemeralErrorResponse;
