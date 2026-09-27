import { Hono } from "hono";
import { ClipsRepository } from "../db/clips-repository";
import { CallbackSecretsRepository } from "../db/callback-secrets-repository";
import { JobsRepository } from "../db/jobs-repository";
import { isSupportedAudioAttachment } from "../discord/attachments";
import {
  DiscordInteractionSchema,
} from "../discord/schemas";
import {
  SEARCH_COMMAND_NAME,
  deferredResponse,
  ephemeralErrorResponse,
  parseShioCommand,
} from "../discord/interactions";
import { formatSearchResults } from "../discord/messages";
import { verifyDiscordSignature } from "../discord/signatures";
import { JobProducer } from "../jobs/producer";

export const interactionRoutes = new Hono<{ Bindings: Env }>();

function parseTemporaryExpiry(url: string): string | null {
  try {
    const raw = new URL(url).searchParams.get("ex");
    if (raw === null) return null;
    const seconds = Number.parseInt(raw, 16);
    return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

function callbackExpiry(now: Date): string {
  return new Date(now.getTime() + 15 * 60 * 1000).toISOString();
}

function parseSearchQuery(input: unknown): string | null {
  const parsed = DiscordInteractionSchema.safeParse(input);
  if (!parsed.success || parsed.data.type !== 2 || parsed.data.data?.name !== SEARCH_COMMAND_NAME) return null;
  const option = parsed.data.data.options?.find((candidate) => candidate.name === "query" && candidate.type === 3);
  return option?.value.trim() || null;
}

interactionRoutes.post("/interactions", async (context) => {
  const signature = context.req.header("x-signature-ed25519");
  const timestamp = context.req.header("x-signature-timestamp");
  if (signature === undefined || timestamp === undefined) return context.text("invalid request signature", 401);
  const body = await context.req.text();
  if (!(await verifyDiscordSignature(context.env.DISCORD_PUBLIC_KEY, signature, timestamp, body))) {
    return context.text("invalid request signature", 401);
  }
  context.executionCtx.waitUntil(
    new CallbackSecretsRepository(context.env.DB).deleteExpired(new Date().toISOString()),
  );
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return ephemeralErrorResponse("Interactionの形式が不正です。");
  }
  const interaction = DiscordInteractionSchema.safeParse(input);
  if (interaction.success && interaction.data.type === 1) return Response.json({ type: 1 });

  const searchQuery = parseSearchQuery(input);
  if (searchQuery !== null) {
    const results = await new ClipsRepository(context.env.DB).search(searchQuery);
    return Response.json({ type: 4, data: { content: formatSearchResults(results), flags: 64 } });
  }

  const command = parseShioCommand(input);
  if (!command.ok) return ephemeralErrorResponse(command.error);
  if (!isSupportedAudioAttachment(command.value.attachment)) {
    return ephemeralErrorResponse("対応していない音声形式です。mp3 / wav / m4a / aac / flac / ogg を指定してください。");
  }
  const configuredMaximum = Number(context.env.MAX_AUDIO_BYTES);
  const maximumBytes = Number.isSafeInteger(configuredMaximum) && configuredMaximum > 0
    ? configuredMaximum
    : 25 * 1024 * 1024;
  if (command.value.attachment.size > maximumBytes) {
    return ephemeralErrorResponse("音声ファイルのサイズが上限を超えています。");
  }

  const now = new Date();
  const producer = new JobProducer(new JobsRepository(context.env.DB), context.env.AUDIO_JOBS);
  try {
    await producer.createAndEnqueue(
      {
        source: {
          type: "interaction",
          guildId: command.value.guildId,
          channelId: command.value.channelId,
          interactionId: command.value.interactionId,
          attachmentId: command.value.attachment.id,
          temporaryReference: {
            url: command.value.attachment.url,
            expiresAt: parseTemporaryExpiry(command.value.attachment.url),
          },
        },
        interactionCallback: {
          token: command.value.interactionToken,
          expiresAt: callbackExpiry(now),
        },
        originalFilename: command.value.attachment.filename,
        contentType: command.value.attachment.contentType,
        sizeBytes: command.value.attachment.size,
        durationSecs: command.value.attachment.durationSecs,
      },
      now.toISOString(),
    );
    return deferredResponse();
  } catch {
    return ephemeralErrorResponse("処理を受け付けられませんでした。時間をおいて再実行してください。");
  }
});
