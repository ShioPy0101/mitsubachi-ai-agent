import { Hono } from "hono";
import { ClipsRepository } from "../db/clips-repository";
import { CallbackSecretsRepository } from "../db/callback-secrets-repository";
import { JobsRepository } from "../db/jobs-repository";
import { GuildAccessRepository } from "../db/guild-access-repository";
import { isSupportedAudioAttachment } from "../discord/attachments";
import { canControlGuild } from "../discord/access-control";
import {
  DiscordInteractionSchema,
} from "../discord/schemas";
import {
  SEARCH_COMMAND_NAME,
  type ParsedDemoCommand,
  deferredResponse,
  ephemeralErrorResponse,
  ephemeralMessageResponse,
  parsePlatformCommand,
} from "../discord/interactions";
import { formatSearchResults } from "../discord/messages";
import { verifyDiscordSignature } from "../discord/signatures";
import { DemoJobProducer, JobProducer, type JobQueue } from "../jobs/producer";
import { sendAudioJobAlert } from "../jobs/alerts";

export const interactionRoutes = new Hono<{ Bindings: Env }>();

type DemoCommandEnv = {
  AUDIO_JOBS: JobQueue;
  DISCORD_CONTROL_USER_IDS: string;
  MAX_AUDIO_BYTES: string;
};

export async function handleDemoCommand(command: ParsedDemoCommand, env: DemoCommandEnv): Promise<Response> {
  if (!canControlGuild(env.DISCORD_CONTROL_USER_IDS, command.userId)) {
    return ephemeralErrorResponse("この操作を実行する権限がありません。");
  }
  if (!isSupportedAudioAttachment(command.attachment)) {
    return ephemeralErrorResponse("対応していない音声形式です。mp3 / wav / m4a / aac / flac / ogg を指定してください。");
  }
  const configuredMaximum = Number(env.MAX_AUDIO_BYTES);
  const maximumBytes = Number.isSafeInteger(configuredMaximum) && configuredMaximum > 0
    ? configuredMaximum
    : 25 * 1024 * 1024;
  if (command.attachment.size > maximumBytes) {
    return ephemeralErrorResponse("音声ファイルのサイズが上限を超えています。");
  }
  try {
    await new DemoJobProducer(env.AUDIO_JOBS).enqueue({
      kind: "demo",
      interactionId: command.interactionId,
      interactionToken: command.interactionToken,
      userId: command.userId as string,
      attachment: command.attachment,
    });
    return deferredResponse();
  } catch (error) {
    console.error("demo_audio_job_enqueue_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error),
      interaction_id: command.interactionId,
      timestamp: new Date().toISOString(),
    });
    return ephemeralErrorResponse("処理を受け付けられませんでした。時間をおいて再実行してください。");
  }
}

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
  return option?.value?.trim() || null;
}

interactionRoutes.post("/interactions", async (context) => {
  const signature = context.req.header("x-signature-ed25519");
  const timestamp = context.req.header("x-signature-timestamp");
  if (signature === undefined || timestamp === undefined) return context.text("invalid request signature", 401);
  const body = await context.req.text();
  if (!(await verifyDiscordSignature(context.env.DISCORD_PUBLIC_KEY, signature, timestamp, body))) {
    return context.text("invalid request signature", 401);
  }
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
    context.executionCtx.waitUntil(
      new CallbackSecretsRepository(context.env.DB).deleteExpired(new Date().toISOString()),
    );
    const guildId = interaction.success ? interaction.data.guild_id : undefined;
    if (guildId === undefined || !(await new GuildAccessRepository(context.env.DB).isEnabled(guildId))) {
      return ephemeralErrorResponse("このサーバーでは利用が許可されていません。");
    }
    const results = await new ClipsRepository(context.env.DB).search(searchQuery, guildId);
    return Response.json({ type: 4, data: { content: formatSearchResults(results), flags: 64 } });
  }

  const command = parsePlatformCommand(input);
  if (!command.ok) return ephemeralErrorResponse(command.error);
  if (command.value.kind === "demo") {
    return handleDemoCommand(command.value, context.env);
  }
  context.executionCtx.waitUntil(
    new CallbackSecretsRepository(context.env.DB).deleteExpired(new Date().toISOString()),
  );
  if (command.value.kind === "access") {
    if (command.value.guildId === null) return ephemeralErrorResponse("サーバー内でのみ実行できます。");
    if (!canControlGuild(context.env.DISCORD_CONTROL_USER_IDS, command.value.userId)) {
      return ephemeralErrorResponse("この操作を実行する権限がありません。");
    }
    const enabled = command.value.action === "allow";
    const updatedAt = new Date().toISOString();
    await new GuildAccessRepository(context.env.DB).setEnabled(
      command.value.guildId,
      enabled,
      command.value.userId as string,
      updatedAt,
    );
    console.info("guild_access_updated", {
      guild_id: command.value.guildId,
      user_id: command.value.userId,
      enabled,
      timestamp: updatedAt,
    });
    return ephemeralMessageResponse(enabled
      ? "このサーバーでの利用を許可しました。"
      : "このサーバーでの利用を停止しました。");
  }
  if (command.value.guildId === null
    || !(await new GuildAccessRepository(context.env.DB).isEnabled(command.value.guildId))) {
    return ephemeralErrorResponse("このサーバーでは利用が許可されていません。");
  }
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
          userId: command.value.userId,
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
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("audio_job_enqueue_failed", {
      errorName,
      errorMessage,
      guild_id: command.value.guildId,
      attachment_id: command.value.attachment.id,
      timestamp: new Date().toISOString(),
    });
    context.executionCtx.waitUntil(sendAudioJobAlert(context.env, {
      interactionId: command.value.interactionId,
      guildId: command.value.guildId,
      attachmentId: command.value.attachment.id,
      filename: command.value.attachment.filename,
      stage: "enqueue",
      errorName,
      errorMessage,
    }));
    return ephemeralErrorResponse("処理を受け付けられませんでした。時間をおいて再実行してください。");
  }
});
