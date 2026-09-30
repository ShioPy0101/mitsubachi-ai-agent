import { z } from "zod";
import { CallbackSecretsRepository } from "../db/callback-secrets-repository";
import { ClipsRepository } from "../db/clips-repository";
import { JobsRepository } from "../db/jobs-repository";
import { D1StationsRepository } from "../db/stations-repository";
import { AttachmentUnavailableError, DiscordRestClient, type DiscordFile } from "../discord/rest-client";
import {
  formatDemoDiagnosticPreviews,
  formatDemoDiagnostics,
  type DemoDiagnostics,
} from "../discord/demo-diagnostics";
import { formatAnalysisResult, formatFailure } from "../discord/messages";
import { GeminiMetadataService, GeminiSafetyBlockedError, isRetryableGeminiError } from "../metadata/gemini";
import { generateRailwayFilename } from "../railway/filename";
import { StationCandidateService } from "../stations/candidate-service";
import { resolveStation } from "../stations/resolver";
import { groupStationSequences } from "../stations/stop-sequences";
import type { TranscriptionResult } from "../transcription/service";
import {
  CloudflareWhisperTranscriptionService,
  isMp3TranscriptionInput,
  whisperModel,
  whisperSettings,
} from "../transcription/workers-ai";
import { formatAudioJobAlert } from "./alerts";
import {
  AudioJobProcessingTimeoutError,
  whisperProcessingTimeoutMs,
} from "./processing-timeout";
import { staleAudioJobCutoff, staleAudioJobTimeoutMs } from "./staleness";
import type { AudioJob, AudioJobMessage, DemoAudioJobMessage } from "./types";
import { createJobMonitor, JobCancellationRequestedError, type JobMonitor } from "./job-monitor";

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
const jobMonitorRefreshIntervalMs = 10_000;

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
  showDemoDiagnostics?: boolean;
};

function errorDetails(error: unknown): { errorName: string; errorMessage: string } {
  if (error instanceof Error) return { errorName: error.name, errorMessage: error.message };
  return { errorName: "UnknownError", errorMessage: String(error) };
}

export async function runStage<T>(
  jobId: string,
  stage: string,
  operation: () => Promise<T>,
  monitor?: JobMonitor,
  timeoutMs?: number,
): Promise<T> {
  await monitor?.assertNotCancelled(jobId, stage);
  await monitor?.stageStarted(jobId, stage, timeoutMs);
  await monitor?.assertNotCancelled(jobId, stage);
  console.info("audio_job_stage_started", { jobId, stage });
  const operationStartedAt = Date.now();
  let refreshPending: Promise<void> | null = null;
  const refreshTimer = monitor?.enabled
    ? setInterval(() => {
      if (refreshPending !== null) return;
      refreshPending = monitor.refresh(jobId).finally(() => { refreshPending = null; });
    }, jobMonitorRefreshIntervalMs)
    : undefined;
  try {
    const result = await operation();
    if (timeoutMs !== undefined && Date.now() - operationStartedAt >= timeoutMs) {
      throw new AudioJobProcessingTimeoutError(timeoutMs);
    }
    await monitor?.assertNotCancelled(jobId, stage);
    console.info("audio_job_stage_completed", { jobId, stage });
    return result;
  } catch (error) {
    if (typeof error === "object" && error !== null) errorStages.set(error, stage);
    console.error("audio_job_stage_failed", { jobId, stage, ...errorDetails(error) });
    throw error;
  } finally {
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    if (refreshPending !== null) await refreshPending;
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
  _asFollowup = false,
): Promise<void> {
  try {
    await editOriginalResponse(job, `🔧 ${content}`, callbacks, discord, "progress");
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

async function notifyDemo(
  job: AudioJob,
  diagnostics: DemoDiagnostics,
  callbacks: ProcessingCallbacks,
  discord: DiscordRestClient,
  file: DiscordFile,
): Promise<boolean> {
  const callback = await runStage(job.id, "discord_callback_lookup", () => callbacks.get(job.id));
  if (callback === null || Date.parse(callback.expiresAt) <= Date.now()) return false;
  const messages = formatDemoDiagnostics(diagnostics);
  const result = await discord.editOriginalResponse(
    callback.token,
    formatAnalysisResult(diagnostics.metadata, diagnostics.normalizedTranscription, diagnostics.filename),
    file,
  );
  if (!result.ok) {
    console.error("demo_diagnostics_original_edit_failed", {
      jobId: job.id, status: result.status, responseBody: result.responseBody,
    });
    return false;
  }
  const debugMarkdown = [
    "# platform-ai-agent-demo debug output",
    "",
    ...messages,
  ].join("\n\n");
  const encodedDebug = new TextEncoder().encode(debugMarkdown);
  const debugFileResult = await discord.sendInteractionFollowup(
    callback.token,
    "📎 完全なデバッグ出力です。画面上の表示は各項目の先頭部分だけに制限しています。",
    {
      data: encodedDebug.buffer.slice(
        encodedDebug.byteOffset,
        encodedDebug.byteOffset + encodedDebug.byteLength,
      ) as ArrayBuffer,
      filename: "platform-ai-agent-demo-debug.md",
      contentType: "text/markdown; charset=utf-8",
    },
  );
  if (!debugFileResult.ok) {
    console.error("demo_diagnostics_file_failed", {
      jobId: job.id,
      status: debugFileResult.status,
      responseBody: debugFileResult.responseBody,
    });
  }
  const previewMessages = formatDemoDiagnosticPreviews(diagnostics);
  for (let index = 0; index < previewMessages.length; index += 1) {
    const followup = await discord.sendInteractionFollowup(callback.token, previewMessages[index]!);
    if (!followup.ok) {
      console.error("demo_diagnostics_followup_failed", {
        jobId: job.id, index, status: followup.status, responseBody: followup.responseBody,
      });
      // The analysis result and audio are already delivered. Debug output is best-effort.
      break;
    }
  }
  return true;
}

const rejectedContentMessage = "この音声は利用条件に合わないため処理できませんでした。";
const emptyTranscriptionMessage = "音声から文字を認識できませんでした。別の音声ファイルでお試しください。";
const staleJobMessage = "音声処理がタイムアウトしたため停止しました。お手数ですが、もう一度コマンドを実行してください。";

function formatDemoFailure(error: unknown, stage: string, attempt: number): string {
  const details = errorDetails(error);
  const message = details.errorMessage.slice(0, 1_300).replaceAll("```", "``\u200b`");
  const retrySummary = stage.startsWith("gemini_")
    ? "同じ文字起こしを使ったGemini再試行（最大3回）も完了できませんでした。"
    : details.errorName === "WhisperAudioDecodeError"
      ? "MP3原本の3030エラー後、MP3フレームのみ再構成した再送もdecodeできませんでした。WAV変換は行っていません。"
    : "この失敗では処理全体を再実行しません。";
  return [
    "❌ **デモ処理に失敗しました**",
    "",
    `失敗ステージ: \`${stage}\``,
    `エラー種別: \`${details.errorName}\``,
    `Queue受信回数: ${attempt}`,
    `再試行: ${retrySummary}`,
    "Queueへの再投入: なし（同じ音声の再文字起こしは行いません）",
    "",
    "エラー内容:",
    `\`\`\`text\n${message}\n\`\`\``,
  ].join("\n");
}

export async function stopStaleAudioJobs(env: Env, now = new Date()): Promise<number> {
  const jobs = new JobsRepository(env.DB);
  const callbacks = new CallbackSecretsRepository(env.DB);
  const discord = new DiscordRestClient(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);
  const monitor = createJobMonitor(env, discord);
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
    await monitor.transition(job.id, "timed_out", "processing_timeout", error);
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
  monitor?: JobMonitor,
): Promise<"completed" | "failed" | "stopped"> {
  const jobs = resources?.jobs ?? new JobsRepository(env.DB);
  const callbacks = resources?.callbacks ?? new CallbackSecretsRepository(env.DB);
  const clips = resources?.clips ?? new ClipsRepository(env.DB);
  const alertsEnabled = resources?.sendAlerts ?? true;
  const showDemoProgress = resources?.showDemoDiagnostics ?? false;
  const discord = new DiscordRestClient(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);
  const runJobStage = <T>(stage: string, operation: () => Promise<T>, timeoutMs?: number): Promise<T> =>
    runStage(job.id, stage, operation, monitor, timeoutMs);
  const attachment = attachmentFor(job);
  let audio: ArrayBuffer | null = null;
  let transcriptionText = job.transcriptionText;
  let transcriptionResult: TranscriptionResult | null = null;
  let needsTranscriptionCheckpoint = false;
  if (transcriptionText === null) {
    await jobs.updateStatus(job.id, "transcribing");
    await updateProgress(job, "音声ファイルを取得しています…", callbacks, discord, showDemoProgress);
    audio = await runJobStage("attachment_download", () =>
      discord.downloadTemporaryAttachment(attachment, maxAudioBytes(env)));
    const transcriptionInput = {
      audio: audio as ArrayBuffer, contentType: job.contentType, filename: job.originalFilename,
      durationSecs: job.durationSecs,
    };
    await updateProgress(
      job,
      isMp3TranscriptionInput(transcriptionInput)
        ? "MP3をWhisperへ送信し、文字起こししています…"
        : "音声をWhisperへ送信し、文字起こししています…",
      callbacks,
      discord,
      showDemoProgress,
    );
    const whisperTimeoutMs = whisperProcessingTimeoutMs(job.durationSecs);
    const transcription = await runJobStage("whisper_transcription", async () => {
      if (isMp3TranscriptionInput(transcriptionInput)) {
        await monitor?.stageProgress(job.id, "MP3原本をWhisperへ直接送信中");
      }
      return new CloudflareWhisperTranscriptionService(
        env.AI,
        async ({ phase }) => {
          if (phase === "rebuild_started") {
            const detail = "MP3直接decode失敗・フレームのみ再構成して再送中";
            await Promise.all([
              updateProgress(job, `${detail}…`, callbacks, discord, showDemoProgress),
              monitor?.stageProgress(job.id, detail),
            ]);
          }
        },
      ).transcribe(transcriptionInput);
    }, whisperTimeoutMs);
    transcriptionResult = transcription;
    if (showDemoProgress) {
      const preparation = transcription.audioPreparation?.strategy === "mp3_rebuilt"
        ? `、MP3フレーム再構成で復旧（${transcription.audioPreparation.submittedBytes} bytes）`
        : "";
      await updateProgress(
        job,
        `Whisperの文字起こしが完了しました（言語: ${transcription.language ?? "不明"}、セグメント: ${transcription.segments.length}件${preparation}）。`,
        callbacks,
        discord,
        true,
      );
    }
    if (!(await jobs.isActive(job.id))) {
      console.warn("audio_job_processing_stopped", { jobId: job.id, stage: "whisper_transcription" });
      return "stopped";
    }
    transcriptionText = transcription.text;
    needsTranscriptionCheckpoint = true;
  } else {
    console.info("audio_job_transcription_checkpoint_reused", { jobId: job.id, attempt });
    await updateProgress(
      job,
      "保存済みの文字起こしを再利用して、メタデータ解析を再開しています…",
      callbacks,
      discord,
      showDemoProgress,
    );
  }
  if (transcriptionText.trim() === "") {
    await jobs.discardTranscription(job.id);
    await jobs.updateStatus(job.id, "failed", "empty_transcription");
    await notify(job, emptyTranscriptionMessage, callbacks, discord);
    await jobs.clearEphemeral(job.id);
    return "failed";
  }
  await jobs.updateStatus(job.id, "metadata_extracting");
  const gemini = new GeminiMetadataService(env.GEMINI_API_KEY, env.GEMINI_MODEL);
  const runGeminiStage = async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
    const maximumGeminiAttempts = showDemoProgress ? 3 : 1;
    let geminiAttempt = 1;
    while (true) {
      try {
        return await runJobStage(stage, operation);
      } catch (error) {
        if (!showDemoProgress || !isRetryableGeminiError(error) || geminiAttempt >= maximumGeminiAttempts) throw error;
        const details = errorDetails(error);
        await updateProgress(
          job,
          `${stage}で一時エラーが発生しました（${details.errorName}: ${details.errorMessage.slice(0, 300)}）。同じ文字起こしのままこの段階だけ再試行します（${geminiAttempt + 1}/${maximumGeminiAttempts}）…`,
          callbacks,
          discord,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, geminiAttempt * 1_000));
        geminiAttempt += 1;
      }
    }
  };
  const handleGeminiFailure = async (
    error: unknown,
    fallbackStage: string,
  ): Promise<"failed" | "stopped"> => {
    if (!(await jobs.isActive(job.id))) {
      console.warn("audio_job_processing_stopped", { jobId: job.id, stage: fallbackStage });
      return "stopped";
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
      return "failed";
    }
    if (isRetryableGeminiError(error)) throw error;
    console.warn("audio_job_metadata_rejected", { jobId: job.id, ...errorDetails(error) });
    if (alertsEnabled) {
      await sendAlert(env, discord, job.id, errorStage(error, fallbackStage), error, attempt);
    }
    await jobs.discardTranscription(job.id);
    await jobs.updateStatus(job.id, "failed", "metadata_extraction_failed");
    await notify(job, formatFailure("processing_failed"), callbacks, discord);
    await jobs.clearEphemeral(job.id);
    return "failed";
  };

  await updateProgress(job, "Gemini #1で放送構造と明示metadataを解析しています…", callbacks, discord, showDemoProgress);
  let analysis: Awaited<ReturnType<GeminiMetadataService["analyze"]>>;
  try {
    analysis = await runGeminiStage("gemini_analysis", () => gemini.analyze(transcriptionText));
  } catch (error) {
    return handleGeminiFailure(error, "gemini_analysis");
  }
  if (!(await jobs.isActive(job.id))) {
    console.warn("audio_job_processing_stopped", { jobId: job.id, stage: "gemini_analysis" });
    return "stopped";
  }
  if (showDemoProgress) {
    await updateProgress(
      job,
      `Gemini #1が完了しました（交通案内判定: ${analysis.isTransitAnnouncement}、駅mention: ${analysis.mentions.length}件）。`,
      callbacks,
      discord,
      true,
    );
  }
  if (!analysis.isTransitAnnouncement) {
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
    return "failed";
  }
  if (needsTranscriptionCheckpoint) {
    await runJobStage("transcription_checkpoint", () => jobs.saveTranscription(job.id, transcriptionText));
  }

  await updateProgress(job, "役割別sequenceごとに駅候補と局所経路を検索しています…", callbacks, discord, showDemoProgress);
  const candidateService = new StationCandidateService(new D1StationsRepository(env.DB));
  const sequenceSearches: DemoDiagnostics["sequenceSearches"] = [];
  for (const { id, role, mentions, contextMentions } of groupStationSequences(analysis.mentions)) {
    if (role === "unknown") continue;
    const searchMentions = [...mentions, ...contextMentions];
    const stationSearch = await runJobStage(`station_candidates_sequence_${id}`, () =>
      candidateService.analyzeMentions(
        searchMentions.map(({ text }) => text),
        {},
        { sequenceRole: role, destinationContext: contextMentions.length > 0 },
      ));
    sequenceSearches.push({ id, role, mentions, contextMentions, stationSearch });
  }
  const candidates = [...new Map(sequenceSearches.flatMap(({ stationSearch }) => stationSearch.candidates)
    .map((candidate) => [candidate.station.id, candidate])).values()];
  if (showDemoProgress) {
    const routeCount = sequenceSearches.reduce((sum, sequence) => sum + sequence.stationSearch.routeCandidates.length, 0);
    await updateProgress(
      job,
      `sequence別探索が完了しました（sequence: ${sequenceSearches.length}件、経路候補: ${routeCount}件、駅候補: ${candidates.length}件）。`,
      callbacks,
      discord,
      true,
    );
  }

  const analysisForNormalization = {
    isTransitAnnouncement: analysis.isTransitAnnouncement,
    mentions: analysis.mentions,
    metadata: analysis.metadata,
  };
  const normalizationSequences = sequenceSearches.map(({ id, role, mentions, contextMentions, stationSearch }) => ({
    id,
    role,
    mentions,
    contextMentions,
    stationCandidates: stationSearch.candidates,
    mentionCandidates: stationSearch.mentionCandidates,
    routeHypotheses: stationSearch.routeCandidates,
  }));
  await updateProgress(job, "Gemini #2で構造とsequence候補に制約された文字起こしを生成しています…", callbacks, discord, showDemoProgress);
  let normalization: Awaited<ReturnType<GeminiMetadataService["normalize"]>>;
  try {
    normalization = await runGeminiStage("gemini_normalization", () =>
      gemini.normalize(transcriptionText, analysisForNormalization, normalizationSequences));
  } catch (error) {
    return handleGeminiFailure(error, "gemini_normalization");
  }
  if (!(await jobs.isActive(job.id))) {
    console.warn("audio_job_processing_stopped", { jobId: job.id, stage: "gemini_normalization" });
    return "stopped";
  }

  const resolution = resolveStation(candidates, analysis.metadata.station);
  const metadata = { ...analysis.metadata, station: resolution.stationName };
  const filename = generateRailwayFilename(metadata, job.originalFilename);
  if (showDemoProgress) {
    await updateProgress(job, `解析結果を組み立てました（生成ファイル名: ${filename}）。`, callbacks, discord, true);
  }
  if (!(await jobs.isActive(job.id))) {
    console.warn("audio_job_processing_stopped", { jobId: job.id, stage: "before_clip_save" });
    return "stopped";
  }
  await runJobStage("clip_save", () => clips.save({
    jobId: job.id, clipIndex: 1, rawTranscription: transcriptionText,
    normalizedTranscription: normalization.normalizedTranscription, metadata, resolution,
    generatedFilename: filename, createdAt: new Date().toISOString(),
  }));
  if (audio === null) {
    await updateProgress(
      job,
      "解析済みの音声ファイルを添付しています…",
      callbacks,
      discord,
      showDemoProgress,
    );
    audio = await runJobStage("attachment_download_for_result", () =>
      discord.downloadTemporaryAttachment(attachment, maxAudioBytes(env)));
  }
  if (!(await jobs.isActive(job.id))) {
    console.warn("audio_job_processing_stopped", { jobId: job.id, stage: "before_result_notification" });
    return "stopped";
  }
  const resultFile = { data: audio, filename, contentType: job.contentType };
  const delivered = await runJobStage("result_notification", () => resources?.showDemoDiagnostics
    ? notifyDemo(job, {
      audioInput: {
        filename: job.originalFilename,
        contentType: job.contentType,
        sizeBytes: job.sizeBytes,
        durationSecs: job.durationSecs,
      },
      whisper: {
        model: whisperModel,
        settings: whisperSettings,
        result: transcriptionResult ?? { language: null, text: transcriptionText, segments: [] },
      },
      transcription: transcriptionText,
      analysis,
      sequenceSearches,
      gemini: {
        analysis: analysis.diagnostics,
        normalization: normalization.diagnostics,
        normalizationGuard: normalization.normalizationGuard,
      },
      isTransitAnnouncement: analysis.isTransitAnnouncement,
      normalizedTranscription: normalization.normalizedTranscription,
      metadata,
      resolution,
      filename,
    }, callbacks, discord, resultFile)
    : notify(
      job,
      formatAnalysisResult(metadata, normalization.normalizedTranscription, filename),
      callbacks,
      discord,
      resultFile,
    ));
  if (!delivered) throw new Error("Discord result notification failed");
  await runJobStage("ephemeral_cleanup", () => jobs.clearEphemeral(job.id));
  await monitor?.assertNotCancelled(job.id, "ephemeral_cleanup");
  await jobs.updateStatus(job.id, "completed");
  return "completed";
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
    showDemoDiagnostics: true,
  };
}

async function processDemoMessage(
  message: DemoAudioJobMessage,
  env: Env,
  attempt: number,
  monitor?: JobMonitor,
): Promise<"completed" | "failed" | "stopped"> {
  return processJob(demoJob(message), env, attempt, demoResources(message), monitor);
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
      const demoMessage = parsed.data;
      const job = demoJob(demoMessage);
      const resources = demoResources(demoMessage);
      const monitor = createJobMonitor(env, discord);
      try {
        await monitor.start(job, message.attempts);
        const outcome = await processDemoMessage(demoMessage, env, message.attempts, monitor);
        await monitor.transition(job.id, outcome === "completed" ? "completed" : outcome, undefined);
        console.info("demo_audio_job_message_acked", {
          interactionId: demoMessage.interactionId,
          queueMessageId: message.id,
          attempt: message.attempts,
        });
        message.ack();
      } catch (error) {
        const details = errorDetails(error);
        const stage = errorStage(error, error instanceof AudioJobProcessingTimeoutError
          ? "processing_timeout"
          : "demo_processing");
        if (error instanceof JobCancellationRequestedError) {
          await monitor.transition(job.id, "stopped", error.stage);
          console.info("demo_audio_job_cancelled", {
            interactionId: demoMessage.interactionId, queueMessageId: message.id, stage: error.stage,
          });
          message.ack();
          continue;
        }
        console.error("demo_audio_job_processing_terminal", {
          interactionId: demoMessage.interactionId,
          queueMessageId: message.id,
          attempt: message.attempts,
          stage,
          ...details,
        });
        await notify(
          job,
          error instanceof AttachmentUnavailableError
            ? formatFailure("attachment_unavailable")
            : formatDemoFailure(error, stage, message.attempts),
          resources.callbacks,
          discord,
        );
        await monitor.transition(
          job.id,
          error instanceof AudioJobProcessingTimeoutError ? "timed_out" : "failed",
          stage,
          error,
        );
        message.ack();
      }
      continue;
    }
    if (!staleJobsChecked) {
      await stopStaleAudioJobs(env);
      staleJobsChecked = true;
    }
    const jobs = new JobsRepository(env.DB);
    const callbacks = new CallbackSecretsRepository(env.DB);
    const monitor = createJobMonitor(env, discord);
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
      await monitor.start(job, message.attempts);
      const outcome = await processJob(job, env, message.attempts, undefined, monitor);
      await monitor.transition(job.id, outcome === "completed" ? "completed" : outcome);
      console.info("audio_job_message_acked", { jobId: job.id, queueMessageId: message.id, attempt: message.attempts });
      message.ack();
    } catch (error) {
      const details = errorDetails(error);
      if (error instanceof JobCancellationRequestedError) {
        console.info("audio_job_cancelled", {
          jobId: job.id, queueMessageId: message.id, attempt: message.attempts, stage: error.stage,
        });
        await jobs.updateStatus(job.id, "failed", "cancelled");
        await jobs.clearEphemeral(job.id);
        await monitor.transition(job.id, "stopped", error.stage);
        message.ack();
        continue;
      }
      if (error instanceof AttachmentUnavailableError
        || error instanceof AudioJobProcessingTimeoutError
        || message.attempts === 1
        || message.attempts >= 5) {
        await sendAlert(env, discord, job.id, errorStage(error, "processing"), error, message.attempts);
      }
      if (error instanceof AttachmentUnavailableError) {
        console.error("audio_job_attachment_terminal", {
          jobId: job.id, queueMessageId: message.id, attempt: message.attempts, ...details,
        });
        await jobs.updateStatus(job.id, "failed", "attachment_unavailable");
        await monitor.transition(job.id, "failed", errorStage(error, "attachment_download"), error);
        await notify(job, formatFailure("attachment_unavailable"), callbacks, discord);
        await jobs.clearEphemeral(job.id);
        console.info("audio_job_message_acked", { jobId: job.id, queueMessageId: message.id, attempt: message.attempts });
        message.ack();
      } else if (error instanceof AudioJobProcessingTimeoutError) {
        console.error("audio_job_processing_timed_out", {
          jobId: job.id, queueMessageId: message.id, attempt: message.attempts, ...details,
        });
        await jobs.updateStatus(job.id, "failed", "processing_timeout");
        await monitor.transition(job.id, "timed_out", errorStage(error, "processing_timeout"), error);
        await notify(job, staleJobMessage, callbacks, discord);
        await jobs.clearEphemeral(job.id);
        console.info("audio_job_message_acked", { jobId: job.id, queueMessageId: message.id, attempt: message.attempts });
        message.ack();
      } else if (message.attempts < 5) {
        const delaySeconds = Math.min(300, 2 ** message.attempts * 5);
        console.error("audio_job_message_retried", {
          jobId: job.id, queueMessageId: message.id, attempt: message.attempts, delaySeconds, ...details,
        });
        await jobs.updateStatus(job.id, "queued", "transient_processing_error");
        await monitor.transition(job.id, "retrying", errorStage(error, "processing"), error);
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
        await monitor.transition(job.id, "failed", errorStage(error, "processing"), error);
        await notify(job, formatFailure("processing_failed"), callbacks, discord);
        await jobs.clearEphemeral(job.id);
        console.info("audio_job_message_acked", { jobId: job.id, queueMessageId: message.id, attempt: message.attempts });
        message.ack();
      }
    }
  }
}
