import { z } from "zod";
import { CallbackSecretsRepository } from "../db/callback-secrets-repository";
import { ClipsRepository } from "../db/clips-repository";
import { JobsRepository } from "../db/jobs-repository";
import { D1StationsRepository } from "../db/stations-repository";
import { AttachmentUnavailableError, DiscordRestClient, type DiscordFile } from "../discord/rest-client";
import { formatAnalysisResult, formatFailure } from "../discord/messages";
import { GeminiMetadataService, GeminiSafetyBlockedError, isRetryableGeminiError } from "../metadata/gemini";
import { generateRailwayFilename } from "../railway/filename";
import { StationCandidateService } from "../stations/candidate-service";
import { resolveStation } from "../stations/resolver";
import { CloudflareWhisperTranscriptionService } from "../transcription/workers-ai";
import { formatAudioJobAlert } from "./alerts";
import { staleAudioJobCutoff, staleAudioJobTimeoutMs } from "./staleness";
import type { AudioJob, AudioJobMessage, DemoAudioJobMessage } from "./types";

const PersistedAudioJobMessageSchema = z.object({
  kind: z.literal("persisted").optional(),
  jobId: z.string().uuid(),
});
const DemoAudioJobMessageSchema = z.object({
  kind: z.literal("demo"),
  interactionId: z.string().min(1),
  interactionToken: z.string().min(1),
  userId: z.string().min(1),
  attachment: z.object({
    id: z.string().min(1),
    filename: z.string().min(1),
    size: z.number().int().nonnegative(),
    url: z.url(),
    contentType: z.string().nullable(),
    durationSecs: z.number().nonnegative().nullable(),
  }),
});
const AudioJobMessageSchema = z.union([DemoAudioJobMessageSchema, PersistedAudioJobMessageSchema]);
const terminalStatuses = new Set(["completed", "partial", "failed"]);
const errorStages = new WeakMap<object, string>();

type ProcessingJobs = Pick<JobsRepository,
  "updateStatus" | "isActive" | "discardTranscription" | "saveTranscription" | "clearEphemeral"
>;
type ProcessingCallbacks = Pick<CallbackSecretsRepository, "get">;
type ProcessingClips = Pick<ClipsRepository, "save">;

type ProcessingResources = {
  jobs: ProcessingJobs;
  callbacks: ProcessingCallbacks;
  clips: ProcessingClips;
  sendAlerts: boolean;
};

function errorDetails(error: unknown): { errorName: string; errorMessage: string } {
  if (error instanceof Error) return { errorName: error.name, errorMessage: error.message };
  return { errorName: "UnknownError", errorMessage: String(error) };
}

async function runStage<T>(jobId: string, stage: string, operation: () => Promise<T>): Promise<T> {
  console.info("audio_job_stage_started", { jobId, stage });
  try {
    const result = await operation();
    console.info("audio_job_stage_completed", { jobId, stage });
    return result;
  } catch (error) {
    if (typeof error === "object" && error !== null) errorStages.set(error, stage);
    console.error("audio_job_stage_failed", { jobId, stage, ...errorDetails(error) });
    throw error;
  }
}

function errorStage(error: unknown, fallback: string): string {
  return typeof error === "object" && error !== null ? errorStages.get(error) ?? fallback : fallback;
}

async function sendAlert(
  env: Env,
  discord: DiscordRestClient,
  jobId: string,
  stage: string,
  error: unknown,
  attempt?: number,
): Promise<void> {
  const channelId = env.DISCORD_ALERT_CHANNEL_ID?.trim();
  if (!channelId) return;
  const details = errorDetails(error);
  try {
    const result = await discord.sendChannelMessage(channelId, formatAudioJobAlert({
      jobId, stage, ...(attempt === undefined ? {} : { attempt }), ...details,
    }));
    if (!result.ok) {
      console.error("audio_job_alert_failed", {
        jobId, stage, status: result.status, responseBody: result.responseBody,
      });
    }
  } catch (alertError) {
    console.error("audio_job_alert_failed", { jobId, stage, ...errorDetails(alertError) });
  }
}

function maxAudioBytes(env: Env): number {
  const parsed = Number(env.MAX_AUDIO_BYTES);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 25 * 1024 * 1024;
}

function attachmentFor(job: AudioJob): { id: string; filename: string; size: number; url: string; contentType: string | null; durationSecs: number | null } {
  const reference = job.source.temporaryReference;
  if (reference === null) throw new AttachmentUnavailableError("attachment_unavailable");
  if (reference.expiresAt !== null && Date.parse(reference.expiresAt) <= Date.now()) {
    throw new AttachmentUnavailableError("attachment_unavailable");
  }
  return {
    id: job.source.attachmentId,
    filename: job.originalFilename,
    size: job.sizeBytes,
    url: reference.url,
    contentType: job.contentType,
    durationSecs: job.durationSecs,
  };
}

async function editOriginalResponse(
  job: AudioJob,
  content: string,
  callbacks: ProcessingCallbacks,
  discord: DiscordRestClient,
  kind: "progress" | "result",
  file?: DiscordFile,
): Promise<boolean> {
  const callback = await runStage(job.id, "discord_callback_lookup", () => callbacks.get(job.id));
  if (callback !== null && Date.parse(callback.expiresAt) > Date.now()) {
    try {
      const result = await discord.editOriginalResponse(callback.token, content, file);
      if (result.ok) {
        console.info("audio_job_discord_original_edited", { jobId: job.id, kind });
        return true;
      } else {
        console.error("audio_job_discord_original_edit_failed", {
          jobId: job.id, kind, status: result.status, responseBody: result.responseBody,
        });
      }
    } catch (error) {
      console.error("audio_job_discord_original_edit_failed", { jobId: job.id, kind, ...errorDetails(error) });
    }
  } else {
    console.warn("audio_job_discord_callback_unavailable", {
      jobId: job.id,
      kind,
      reason: callback === null ? "missing" : "expired",
    });
  }
  return false;
}

async function updateProgress(
  job: AudioJob,
  content: string,
  callbacks: ProcessingCallbacks,
  discord: DiscordRestClient,
): Promise<void> {
  try {
    await editOriginalResponse(job, content, callbacks, discord, "progress");
  } catch (error) {
    console.error("audio_job_progress_update_failed", { jobId: job.id, ...errorDetails(error) });
  }
}

async function notify(
  job: AudioJob,
  content: string,
  callbacks: ProcessingCallbacks,
  discord: DiscordRestClient,
  file?: DiscordFile,
): Promise<boolean> {
  const originalEdited = await editOriginalResponse(job, content, callbacks, discord, "result", file);
  if (originalEdited) return true;
  if (!originalEdited && job.source.channelId !== null) {
    try {
      const result = await discord.sendChannelMessage(job.source.channelId, content, file);
      if (result.ok) {
        console.info("audio_job_discord_channel_sent", { jobId: job.id });
        return true;
      } else {
        console.error("audio_job_discord_channel_send_failed", {
          jobId: job.id, status: result.status, responseBody: result.responseBody,
        });
      }
    } catch (error) {
      console.error("audio_job_discord_channel_send_failed", { jobId: job.id, ...errorDetails(error) });
      // The terminal state remains queryable even when Discord is temporarily unavailable.
    }
  }
  return false;
}

const rejectedContentMessage = "この音声は利用条件に合わないため処理できませんでした。";
const emptyTranscriptionMessage = "音声から文字を認識できませんでした。別の音声ファイルでお試しください。";
const staleJobMessage = "音声処理がタイムアウトしたため停止しました。お手数ですが、もう一度コマンドを実行してください。";

export async function stopStaleAudioJobs(env: Env, now = new Date()): Promise<number> {
  const jobs = new JobsRepository(env.DB);
  const callbacks = new CallbackSecretsRepository(env.DB);
  const discord = new DiscordRestClient(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);
  const staleJobs = await jobs.findStaleActive(staleAudioJobCutoff(now));
  let stopped = 0;

  for (const job of staleJobs) {
    const didStop = await jobs.failIfActive(job.id, "processing_timeout", now.toISOString());
    if (!didStop) continue;
    stopped += 1;
    const error = new Error(
      `audio job exceeded ${staleAudioJobTimeoutMs / 60_000} minute limit `
      + `(status=${job.status}, createdAt=${job.createdAt}, startedAt=${job.startedAt ?? "none"})`,
    );
    console.error("audio_job_stale_stopped", { jobId: job.id, ...errorDetails(error) });
    await sendAlert(env, discord, job.id, "processing_timeout", error);
    try {
      await notify(job, staleJobMessage, callbacks, discord);
    } catch (notificationError) {
      console.error("audio_job_timeout_notification_failed", {
        jobId: job.id,
        ...errorDetails(notificationError),
      });
    }
    await jobs.clearEphemeral(job.id);
  }
  return stopped;
}

async function processJob(
  job: AudioJob,
  env: Env,
  attempt: number,
  resources?: ProcessingResources,
): Promise<void> {
  const jobs = resources?.jobs ?? new JobsRepository(env.DB);
  const callbacks = resources?.callbacks ?? new CallbackSecretsRepository(env.DB);
  const clips = resources?.clips ?? new ClipsRepository(env.DB);
  const alertsEnabled = resources?.sendAlerts ?? true;
  const discord = new DiscordRestClient(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);
  const attachment = attachmentFor(job);
  let audio: ArrayBuffer | null = null;
  let transcriptionText = job.transcriptionText;
  let needsTranscriptionCheckpoint = false;
  if (transcriptionText === null) {
    await jobs.updateStatus(job.id, "transcribing");
    await updateProgress(job, "音声ファイルを取得しています…", callbacks, discord);
    audio = await runStage(job.id, "attachment_download", () =>
      discord.downloadTemporaryAttachment(attachment, maxAudioBytes(env)));
    await updateProgress(job, "音声を文字起こししています…", callbacks, discord);
    const transcription = await runStage(job.id, "whisper_transcription", () =>
      new CloudflareWhisperTranscriptionService(env.AI).transcribe({
        audio: audio as ArrayBuffer, contentType: job.contentType, filename: job.originalFilename,
        durationSecs: job.durationSecs,
      }));
    if (!(await jobs.isActive(job.id))) {
      console.warn("audio_job_processing_stopped", { jobId: job.id, stage: "whisper_transcription" });
      return;
    }
    transcriptionText = transcription.text;
    needsTranscriptionCheckpoint = true;
  } else {
    console.info("audio_job_transcription_checkpoint_reused", { jobId: job.id, attempt });
    await updateProgress(job, "保存済みの文字起こしを再利用して、メタデータ解析を再開しています…", callbacks, discord);
  }
  if (transcriptionText.trim() === "") {
    await jobs.discardTranscription(job.id);
    await jobs.updateStatus(job.id, "failed", "empty_transcription");
    await notify(job, emptyTranscriptionMessage, callbacks, discord);
    await jobs.clearEphemeral(job.id);
    return;
  }
  await jobs.updateStatus(job.id, "metadata_extracting");
  await updateProgress(job, "文字起こしが完了しました。利用条件とメタデータを確認しています…", callbacks, discord);
  const candidateService = new StationCandidateService(new D1StationsRepository(env.DB));
  const candidates = await runStage(job.id, "station_candidates", () => candidateService.candidates(transcriptionText));
  let extracted: Awaited<ReturnType<GeminiMetadataService["extract"]>>;
  try {
    extracted = await runStage(job.id, "gemini_metadata", () =>
      new GeminiMetadataService(env.GEMINI_API_KEY, env.GEMINI_MODEL).extract(transcriptionText, candidates));
  } catch (error) {
    if (!(await jobs.isActive(job.id))) {
      console.warn("audio_job_processing_stopped", { jobId: job.id, stage: "gemini_metadata" });
      return;
    }
    if (error instanceof GeminiSafetyBlockedError) {
      console.warn("audio_job_safety_blocked", {
        user_id: job.source.userId,
        guild_id: job.source.guildId,
        attachment_id: job.source.attachmentId,
        blocked_category: error.blockedCategories.join(",") || "SAFETY",
        timestamp: new Date().toISOString(),
      });
      await jobs.discardTranscription(job.id);
      await jobs.updateStatus(job.id, "failed", "content_policy_blocked");
      await notify(job, rejectedContentMessage, callbacks, discord);
      await jobs.clearEphemeral(job.id);
      return;
    }
    if (isRetryableGeminiError(error)) throw error;
    console.warn("audio_job_metadata_rejected", { jobId: job.id, ...errorDetails(error) });
    if (alertsEnabled) {
      await sendAlert(env, discord, job.id, errorStage(error, "metadata_processing"), error, attempt);
    }
    await jobs.discardTranscription(job.id);
    await jobs.updateStatus(job.id, "failed", "metadata_extraction_failed");
    await notify(job, formatFailure("processing_failed"), callbacks, discord);
    await jobs.clearEphemeral(job.id);
    return;
  }
  if (!(await jobs.isActive(job.id))) {
    console.warn("audio_job_processing_stopped", { jobId: job.id, stage: "gemini_metadata" });
    return;
  }
  if (!extracted.isTransitAnnouncement) {
    console.warn("audio_job_non_transit_blocked", {
      user_id: job.source.userId,
      guild_id: job.source.guildId,
      attachment_id: job.source.attachmentId,
      blocked_category: "NON_TRANSIT_CONTENT",
      timestamp: new Date().toISOString(),
    });
    await jobs.discardTranscription(job.id);
    await jobs.updateStatus(job.id, "failed", "non_transit_content");
    await notify(job, rejectedContentMessage, callbacks, discord);
    await jobs.clearEphemeral(job.id);
    return;
  }
  if (needsTranscriptionCheckpoint) {
    await runStage(job.id, "transcription_checkpoint", () => jobs.saveTranscription(job.id, transcriptionText));
  }
  const resolution = resolveStation(candidates, extracted.metadata.station);
  const metadata = { ...extracted.metadata, station: resolution.stationName };
  const filename = generateRailwayFilename(metadata, job.originalFilename);
  if (!(await jobs.isActive(job.id))) {
    console.warn("audio_job_processing_stopped", { jobId: job.id, stage: "before_clip_save" });
    return;
  }
  await runStage(job.id, "clip_save", () => clips.save({
    jobId: job.id, clipIndex: 1, rawTranscription: transcriptionText,
    normalizedTranscription: extracted.normalizedTranscription, metadata, resolution,
    generatedFilename: filename, createdAt: new Date().toISOString(),
  }));
  if (audio === null) {
    await updateProgress(job, "解析済みの音声ファイルを添付しています…", callbacks, discord);
    audio = await runStage(job.id, "attachment_download_for_result", () =>
      discord.downloadTemporaryAttachment(attachment, maxAudioBytes(env)));
  }
  if (!(await jobs.isActive(job.id))) {
    console.warn("audio_job_processing_stopped", { jobId: job.id, stage: "before_result_notification" });
    return;
  }
  const delivered = await notify(
    job,
    formatAnalysisResult(metadata, extracted.normalizedTranscription, filename),
    callbacks,
    discord,
    { data: audio, filename, contentType: job.contentType },
  );
  if (!delivered) throw new Error("Discord result notification failed");
  await jobs.updateStatus(job.id, "completed");
  await runStage(job.id, "ephemeral_cleanup", () => jobs.clearEphemeral(job.id));
}

function demoJob(message: DemoAudioJobMessage): AudioJob {
  return {
    id: `demo:${message.interactionId}`,
    source: {
      type: "interaction",
      guildId: null,
      channelId: null,
      userId: message.userId,
      interactionId: message.interactionId,
      attachmentId: message.attachment.id,
      temporaryReference: { url: message.attachment.url, expiresAt: null },
    },
    originalFilename: message.attachment.filename,
    contentType: message.attachment.contentType,
    sizeBytes: message.attachment.size,
    durationSecs: message.attachment.durationSecs,
    status: "queued",
    errorMessage: null,
    transcriptionText: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
}

function demoResources(message: DemoAudioJobMessage): ProcessingResources {
  return {
    jobs: {
      updateStatus: async () => {},
      isActive: async () => true,
      discardTranscription: async () => {},
      saveTranscription: async () => {},
      clearEphemeral: async () => {},
    },
    callbacks: {
      get: async () => ({ token: message.interactionToken, expiresAt: "9999-12-31T23:59:59.999Z" }),
    },
    clips: { save: async () => {} },
    sendAlerts: false,
  };
}

async function processDemoMessage(
  message: DemoAudioJobMessage,
  env: Env,
  attempt: number,
): Promise<void> {
  await processJob(demoJob(message), env, attempt, demoResources(message));
}

export async function consumeAudioJobs(batch: MessageBatch<AudioJobMessage>, env: Env): Promise<void> {
  const discord = new DiscordRestClient(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);
  let staleJobsChecked = false;
  for (const message of batch.messages) {
    console.info("audio_job_message_received", { queueMessageId: message.id, attempt: message.attempts });
    const parsed = AudioJobMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error("audio_job_message_invalid", { queueMessageId: message.id, attempt: message.attempts });
      message.ack();
      continue;
    }
    if (parsed.data.kind === "demo") {
      const job = demoJob(parsed.data);
      const resources = demoResources(parsed.data);
      try {
        await processDemoMessage(parsed.data, env, message.attempts);
        console.info("demo_audio_job_message_acked", {
          interactionId: parsed.data.interactionId,
          queueMessageId: message.id,
          attempt: message.attempts,
        });
        message.ack();
      } catch (error) {
        const details = errorDetails(error);
        if (error instanceof AttachmentUnavailableError || message.attempts >= 5) {
          console.error("demo_audio_job_processing_terminal", {
            interactionId: parsed.data.interactionId,
            queueMessageId: message.id,
            attempt: message.attempts,
            ...details,
          });
          await notify(
            job,
            formatFailure(error instanceof AttachmentUnavailableError ? "attachment_unavailable" : "processing_failed"),
            resources.callbacks,
            discord,
          );
          message.ack();
        } else {
          const delaySeconds = Math.min(300, 2 ** message.attempts * 5);
          await updateProgress(
            job,
            `処理中に一時的なエラーが発生しました。再試行を待っています（次回 ${message.attempts + 1}/5）…`,
            resources.callbacks,
            discord,
          );
          message.retry({ delaySeconds });
        }
      }
      continue;
    }
    if (!staleJobsChecked) {
      await stopStaleAudioJobs(env);
      staleJobsChecked = true;
    }
    const jobs = new JobsRepository(env.DB);
    const callbacks = new CallbackSecretsRepository(env.DB);
    const job = await jobs.findById(parsed.data.jobId);
    if (job === null || terminalStatuses.has(job.status)) {
      console.info("audio_job_message_skipped", {
        jobId: parsed.data.jobId,
        queueMessageId: message.id,
        attempt: message.attempts,
        reason: job === null ? "missing" : `terminal_${job.status}`,
      });
      message.ack();
      continue;
    }
    try {
      await processJob(job, env, message.attempts);
      console.info("audio_job_message_acked", { jobId: job.id, queueMessageId: message.id, attempt: message.attempts });
      message.ack();
    } catch (error) {
      const details = errorDetails(error);
      if (error instanceof AttachmentUnavailableError || message.attempts === 1 || message.attempts >= 5) {
        await sendAlert(env, discord, job.id, errorStage(error, "processing"), error, message.attempts);
      }
      if (error instanceof AttachmentUnavailableError) {
        console.error("audio_job_attachment_terminal", {
          jobId: job.id, queueMessageId: message.id, attempt: message.attempts, ...details,
        });
        await jobs.updateStatus(job.id, "failed", "attachment_unavailable");
        await notify(job, formatFailure("attachment_unavailable"), callbacks, discord);
        await jobs.clearEphemeral(job.id);
        console.info("audio_job_message_acked", { jobId: job.id, queueMessageId: message.id, attempt: message.attempts });
        message.ack();
      } else if (message.attempts < 5) {
        const delaySeconds = Math.min(300, 2 ** message.attempts * 5);
        console.error("audio_job_message_retried", {
          jobId: job.id, queueMessageId: message.id, attempt: message.attempts, delaySeconds, ...details,
        });
        await jobs.updateStatus(job.id, "queued", "transient_processing_error");
        await updateProgress(
          job,
          `処理中に一時的なエラーが発生しました。再試行を待っています（次回 ${message.attempts + 1}/5）…`,
          callbacks,
          discord,
        );
        message.retry({ delaySeconds });
      } else {
        console.error("audio_job_processing_terminal", {
          jobId: job.id, queueMessageId: message.id, attempt: message.attempts, ...details,
        });
        await jobs.updateStatus(job.id, "failed", "processing_failed");
        await notify(job, formatFailure("processing_failed"), callbacks, discord);
        await jobs.clearEphemeral(job.id);
        console.info("audio_job_message_acked", { jobId: job.id, queueMessageId: message.id, attempt: message.attempts });
        message.ack();
      }
    }
  }
}
