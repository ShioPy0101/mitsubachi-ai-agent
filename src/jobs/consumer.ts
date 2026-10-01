import { z } from "zod";

import { CallbackSecretsRepository } from "../db/callback-secrets-repository";
import { ClipsRepository } from "../db/clips-repository";
import { JobsRepository } from "../db/jobs-repository";
import { createD1StationsJobCache, D1StationsRepository } from "../db/stations-repository";

import { AttachmentUnavailableError, DiscordRestClient, type DiscordFile } from "../discord/rest-client";

import { formatDemoDiagnosticPreviews, formatDemoDiagnostics, type DemoDiagnostics } from "../discord/demo-diagnostics";

import { formatAnalysisResult, formatFailure } from "../discord/messages";

import { applyNormalizedEntitiesToMetadata, GeminiMetadataService, GeminiSafetyBlockedError, isRetryableGeminiError } from "../metadata/gemini";

import { generateRailwayFilename } from "../railway/filename";

import { reconcileStationMentionCandidates, StationCandidateService } from "../stations/candidate-service";

import { resolveStation } from "../stations/resolver";
import { groupStationSequences } from "../stations/stop-sequences";

import type { TranscriptionResult } from "../transcription/service";

import {
  CloudflareWhisperTranscriptionService,
  isMp3TranscriptionInput,
  WhisperAudioDecodeError,
  whisperModel,
  whisperSettings,
} from "../transcription/workers-ai";

import { formatAudioJobAlert } from "./alerts";

import { AudioJobProcessingTimeoutError, whisperProcessingTimeoutMs } from "./processing-timeout";

import { audioJobElapsedMs, isStaleAudioJob, staleAudioJobCutoff, staleAudioJobTimeoutMs } from "./staleness";

import type { AudioJob, AudioJobMessage, DemoAudioJobMessage } from "./types";

import { createJobMonitor, JobCancellationRequestedError, type JobMonitor } from "./job-monitor";

import { formatStationCandidateJobProgress, StationCandidatePerformanceWarning, stationCandidatePerformanceWarning } from "./station-observability";

/* -------------------------------------------------------------------------- */
/* Message schemas                                                            */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const terminalStatuses = new Set(["completed", "partial", "failed"]);

const maximumQueueAttempts = 5;
const maximumGeminiAttempts = 3;

const jobMonitorRefreshIntervalMs = 10_000;

const noPipelineRetryStages = new Set(["transcription_checkpoint", "result_notification", "completion_status"]);

/**
 * ステージ単位の上限。
 *
 * ジョブ全体の staleAudioJobTimeoutMs よりも短くすることで、
 * 1つの外部APIやD1探索がジョブ全体を占有しないようにする。
 */
const stageTimeouts = {
  discordCallbackLookup: 15_000,
  attachmentDownload: 45_000,

  geminiAnalysis: 90_000,
  stationCandidates: 90_000,
  geminiNormalization: 90_000,

  transcriptionCheckpoint: 20_000,
  clipSave: 20_000,

  resultNotification: 45_000,
  ephemeralCleanup: 20_000,
  completionStatus: 20_000,
} as const;

/* -------------------------------------------------------------------------- */
/* Internal types                                                             */
/* -------------------------------------------------------------------------- */

type ProcessingJobs = Pick<JobsRepository, "updateStatus" | "isActive" | "discardTranscription" | "saveTranscription" | "clearEphemeral">;

type ProcessingCallbacks = Pick<CallbackSecretsRepository, "get">;

type ProcessingClips = Pick<ClipsRepository, "save">;

type ProcessingResources = {
  jobs: ProcessingJobs;
  callbacks: ProcessingCallbacks;
  clips: ProcessingClips;
  sendAlerts: boolean;
  showDemoDiagnostics?: boolean;
};

/* -------------------------------------------------------------------------- */
/* Error helpers                                                              */
/* -------------------------------------------------------------------------- */

const errorStages = new WeakMap<object, string>();

function errorDetails(error: unknown): {
  errorName: string;
  errorMessage: string;
} {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: String(error),
  };
}

function errorStage(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null) {
    return fallback;
  }

  return errorStages.get(error) ?? fallback;
}

function tagErrorStage(error: unknown, stage: string): void {
  if (typeof error === "object" && error !== null) {
    errorStages.set(error, stage);
  }
}

/* -------------------------------------------------------------------------- */
/* Stage runner                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 重要:
 *
 * AbortController.abort() だけでは、operation が AbortSignal を
 * 無視している場合 Promise 自体は終了しない。
 *
 * そのため、
 *
 *   operationPromise
 *      vs
 *   abortPromise
 *
 * を Promise.race() する。
 *
 * これによって外部処理が AbortSignal 非対応でも、
 * 呼び出し側は timeout / cancel 時点で処理を抜けることができる。
 *
 * 注意:
 * Promise.race から外れた underlying operation を物理的に停止できるとは
 * 限らない。可能なAPIについては signal を実処理まで渡す。
 */
export async function runStage<T>(
  jobId: string,
  stage: string,
  operation: (signal: AbortSignal) => Promise<T>,
  monitor?: JobMonitor,
  timeoutMs?: number,
): Promise<T> {
  await monitor?.assertNotCancelled(jobId, stage);

  await monitor?.stageStarted(jobId, stage, timeoutMs);

  await monitor?.assertNotCancelled(jobId, stage);

  console.info("audio_job_stage_started", {
    jobId,
    stage,
    timeoutMs: timeoutMs ?? null,
  });

  const operationStartedAt = Date.now();

  const controller = new AbortController();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  let refreshPending: Promise<void> | null = null;

  /*
   * AbortSignal を処理本体が無視していても
   * Promise.race を終了させるための Promise。
   */
  const abortPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        reject(controller.signal.reason ?? new Error(`stage aborted: ${stage}`));
      },
      {
        once: true,
      },
    );
  });

  if (timeoutMs !== undefined) {
    timeoutId = setTimeout(() => {
      if (controller.signal.aborted) {
        return;
      }

      controller.abort(new AudioJobProcessingTimeoutError(timeoutMs));
    }, timeoutMs);
  }

  const refreshTimer = monitor?.enabled
    ? setInterval(() => {
        if (refreshPending !== null) {
          return;
        }

        refreshPending = Promise.all([monitor.refresh(jobId), monitor.assertNotCancelled(jobId, stage)])
          .then(() => undefined)
          .catch((error: unknown) => {
            if (error instanceof JobCancellationRequestedError) {
              if (!controller.signal.aborted) {
                controller.abort(error);
              }

              return;
            }

            console.error("audio_job_monitor_refresh_failed", {
              jobId,
              stage,
              ...errorDetails(error),
            });
          })
          .finally(() => {
            refreshPending = null;
          });
      }, jobMonitorRefreshIntervalMs)
    : undefined;

  try {
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));

    const result = await Promise.race([operationPromise, abortPromise]);

    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new Error(`stage aborted: ${stage}`);
    }

    /*
     * Event loop が長時間ブロックされたケースなど、
     * setTimeout が時間通り実行されなかった場合の保険。
     */
    if (timeoutMs !== undefined && Date.now() - operationStartedAt >= timeoutMs) {
      throw new AudioJobProcessingTimeoutError(timeoutMs);
    }

    await monitor?.assertNotCancelled(jobId, stage);

    console.info("audio_job_stage_completed", {
      jobId,
      stage,
      elapsedMs: Date.now() - operationStartedAt,
    });

    return result;
  } catch (error) {
    const stageError = controller.signal.aborted ? (controller.signal.reason ?? error) : error;

    tagErrorStage(stageError, stage);

    console.error("audio_job_stage_failed", {
      jobId,
      stage,
      elapsedMs: Date.now() - operationStartedAt,
      ...errorDetails(stageError),
    });

    throw stageError;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer);
    }

    /*
     * refreshPending をここで await すると、
     * monitor backend が固まったときに
     * stage timeout 後も finally で待たされる。
     *
     * refreshPending 側は自身で catch 済みなので、
     * stage終了時には待たない。
     */
  }
}

/* -------------------------------------------------------------------------- */
/* Retry policy                                                               */
/* -------------------------------------------------------------------------- */

export function shouldRetryAudioJob(error: unknown, attempt: number): boolean {
  if (attempt >= maximumQueueAttempts) {
    return false;
  }

  if (
    error instanceof AttachmentUnavailableError ||
    error instanceof AudioJobProcessingTimeoutError ||
    error instanceof JobCancellationRequestedError ||
    error instanceof WhisperAudioDecodeError
  ) {
    return false;
  }

  return !noPipelineRetryStages.has(errorStage(error, "processing"));
}

/* -------------------------------------------------------------------------- */
/* Discord alert                                                              */
/* -------------------------------------------------------------------------- */

async function sendAlert(
  env: Env,
  discord: DiscordRestClient,
  jobId: string,
  stage: string,
  error: unknown,
  attempt?: number,
  severity: "error" | "warning" = "error",
): Promise<void> {
  const channelId = env.DISCORD_ALERT_CHANNEL_ID?.trim();

  if (!channelId) {
    return;
  }

  const details = errorDetails(error);

  try {
    const result = await discord.sendChannelMessage(
      channelId,
      formatAudioJobAlert({
        jobId,
        stage,
        ...(attempt === undefined ? {} : { attempt }),
        severity,
        ...details,
      }),
    );

    if (!result.ok) {
      console.error("audio_job_alert_failed", {
        jobId,
        stage,
        status: result.status,
        responseBody: result.responseBody,
      });
    }
  } catch (alertError) {
    console.error("audio_job_alert_failed", {
      jobId,
      stage,
      ...errorDetails(alertError),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Attachment helpers                                                         */
/* -------------------------------------------------------------------------- */

function maxAudioBytes(env: Env): number {
  const parsed = Number(env.MAX_AUDIO_BYTES);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 25 * 1024 * 1024;
}

function attachmentFor(job: AudioJob): {
  id: string;
  filename: string;
  size: number;
  url: string;
  contentType: string | null;
  durationSecs: number | null;
} {
  const reference = job.source.temporaryReference;

  if (reference === null) {
    throw new AttachmentUnavailableError("attachment_unavailable");
  }

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

/* -------------------------------------------------------------------------- */
/* Discord response helpers                                                   */
/* -------------------------------------------------------------------------- */

async function editOriginalResponse(
  job: AudioJob,
  content: string,
  callbacks: ProcessingCallbacks,
  discord: DiscordRestClient,
  kind: "progress" | "result",
  file?: DiscordFile,
): Promise<boolean> {
  const callback = await runStage(job.id, "discord_callback_lookup", () => callbacks.get(job.id), undefined, stageTimeouts.discordCallbackLookup);

  if (callback !== null && Date.parse(callback.expiresAt) > Date.now()) {
    try {
      const result = await discord.editOriginalResponse(callback.token, content, file);

      if (result.ok) {
        console.info("audio_job_discord_original_edited", {
          jobId: job.id,
          kind,
        });

        return true;
      }

      console.error("audio_job_discord_original_edit_failed", {
        jobId: job.id,
        kind,
        status: result.status,
        responseBody: result.responseBody,
      });
    } catch (error) {
      console.error("audio_job_discord_original_edit_failed", {
        jobId: job.id,
        kind,
        ...errorDetails(error),
      });
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

async function updateProgress(job: AudioJob, content: string, callbacks: ProcessingCallbacks, discord: DiscordRestClient, _asFollowup = false): Promise<void> {
  try {
    await editOriginalResponse(job, `🔧 ${content}`, callbacks, discord, "progress");
  } catch (error) {
    console.error("audio_job_progress_update_failed", {
      jobId: job.id,
      ...errorDetails(error),
    });
  }
}

async function notify(job: AudioJob, content: string, callbacks: ProcessingCallbacks, discord: DiscordRestClient, file?: DiscordFile): Promise<boolean> {
  const originalEdited = await editOriginalResponse(job, content, callbacks, discord, "result", file);

  if (originalEdited) {
    return true;
  }

  if (job.source.channelId !== null) {
    try {
      const result = await discord.sendChannelMessage(job.source.channelId, content, file);

      if (result.ok) {
        console.info("audio_job_discord_channel_sent", {
          jobId: job.id,
        });

        return true;
      }

      console.error("audio_job_discord_channel_send_failed", {
        jobId: job.id,
        status: result.status,
        responseBody: result.responseBody,
      });
    } catch (error) {
      console.error("audio_job_discord_channel_send_failed", {
        jobId: job.id,
        ...errorDetails(error),
      });
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
  const callback = await runStage(job.id, "discord_callback_lookup", () => callbacks.get(job.id), undefined, stageTimeouts.discordCallbackLookup);

  if (callback === null || Date.parse(callback.expiresAt) <= Date.now()) {
    return false;
  }

  const messages = formatDemoDiagnostics(diagnostics);

  const result = await discord.editOriginalResponse(
    callback.token,
    formatAnalysisResult(diagnostics.metadata, diagnostics.normalizedTranscription, diagnostics.filename),
    file,
  );

  if (!result.ok) {
    console.error("demo_diagnostics_original_edit_failed", {
      jobId: job.id,
      status: result.status,
      responseBody: result.responseBody,
    });

    return false;
  }

  const debugMarkdown = ["# platform-ai-agent-demo debug output", "", ...messages].join("\n\n");

  const encodedDebug = new TextEncoder().encode(debugMarkdown);

  const debugFileResult = await discord.sendInteractionFollowup(
    callback.token,
    "📎 完全なデバッグ出力です。画面上の表示は各項目の先頭部分だけに制限しています。",
    {
      data: encodedDebug.buffer.slice(encodedDebug.byteOffset, encodedDebug.byteOffset + encodedDebug.byteLength) as ArrayBuffer,
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
        jobId: job.id,
        index,
        status: followup.status,
        responseBody: followup.responseBody,
      });

      break;
    }
  }

  return true;
}

/* -------------------------------------------------------------------------- */
/* User-visible messages                                                      */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Stale job watchdog                                                         */
/* -------------------------------------------------------------------------- */

export async function stopStaleAudioJobs(env: Env, now = new Date()): Promise<number> {
  const jobs = new JobsRepository(env.DB);

  const callbacks = new CallbackSecretsRepository(env.DB);

  const discord = new DiscordRestClient(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);

  const monitor = createJobMonitor(env, discord);

  const cutoff = staleAudioJobCutoff(now);

  const staleJobs = await jobs.findStaleActive(cutoff);

  let stopped = 0;

  for (const job of staleJobs) {
    const elapsedMs = audioJobElapsedMs(job.createdAt, job.startedAt, now);

    if (!isStaleAudioJob(job.createdAt, job.startedAt, now)) {
      console.error("audio_job_false_stale_candidate_skipped", {
        jobId: job.id,
        status: job.status,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        observedAt: now.toISOString(),
        cutoff,
        elapsedMs,
      });

      continue;
    }

    const didStop = await jobs.failIfStaleActive(job.id, cutoff, "processing_timeout", now.toISOString());

    if (!didStop) {
      continue;
    }

    stopped += 1;

    const error = new Error(
      `audio job exceeded ${staleAudioJobTimeoutMs / 60_000} minute limit ` +
        `(status=${job.status}, ` +
        `createdAt=${job.createdAt}, ` +
        `startedAt=${job.startedAt ?? "none"}, ` +
        `observedAt=${now.toISOString()}, ` +
        `elapsedSeconds=${elapsedMs === null ? "invalid" : (elapsedMs / 1000).toFixed(1)}, ` +
        `cutoff=${cutoff})`,
    );

    console.error("audio_job_stale_stopped", {
      jobId: job.id,
      ...errorDetails(error),
    });

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

/* -------------------------------------------------------------------------- */
/* Main pipeline                                                              */
/* -------------------------------------------------------------------------- */

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

  /*
   * Queue再試行の場合も元の startedAt を基準にする。
   *
   * demo は startedAt=null なので processJob 呼び出し時刻を採用する。
   */
  const persistedStartMs = job.startedAt !== null ? Date.parse(job.startedAt) : Number.NaN;

  const processStartedAt = Number.isFinite(persistedStartMs) ? persistedStartMs : Date.now();

  const globalDeadlineAt = processStartedAt + staleAudioJobTimeoutMs;

  function remainingJobMs(): number {
    return Math.max(0, globalDeadlineAt - Date.now());
  }

  /**
   * 各stageには
   *
   *   min(stage timeout, job全体の残り時間)
   *
   * を与える。
   */
  const runJobStage = <T>(stage: string, operation: (signal: AbortSignal) => Promise<T>, stageTimeoutMs?: number): Promise<T> => {
    const remaining = remainingJobMs();

    if (remaining <= 0) {
      const error = new AudioJobProcessingTimeoutError(staleAudioJobTimeoutMs);

      tagErrorStage(error, stage);

      return Promise.reject(error);
    }

    const effectiveTimeout = stageTimeoutMs === undefined ? remaining : Math.min(stageTimeoutMs, remaining);

    return runStage(job.id, stage, operation, monitor, effectiveTimeout);
  };

  const attachment = attachmentFor(job);

  let audio: ArrayBuffer | null = null;

  let transcriptionText = job.transcriptionText;

  let transcriptionResult: TranscriptionResult | null = null;

  let needsTranscriptionCheckpoint = false;

  /* ---------------------------------------------------------------------- */
  /* Whisper                                                                */
  /* ---------------------------------------------------------------------- */

  if (transcriptionText === null) {
    await jobs.updateStatus(job.id, "transcribing");

    await updateProgress(job, "音声ファイルを取得しています…", callbacks, discord, showDemoProgress);

    audio = await runJobStage(
      "attachment_download",
      () => discord.downloadTemporaryAttachment(attachment, maxAudioBytes(env)),
      stageTimeouts.attachmentDownload,
    );

    const transcriptionInput = {
      audio: audio as ArrayBuffer,
      contentType: job.contentType,
      filename: job.originalFilename,
      durationSecs: job.durationSecs,
    };

    await updateProgress(
      job,
      isMp3TranscriptionInput(transcriptionInput) ? "MP3を文字起こししています…" : "音声を文字起こししています…",
      callbacks,
      discord,
      showDemoProgress,
    );

    const whisperTimeoutMs = whisperProcessingTimeoutMs(job.durationSecs);

    const transcription = await runJobStage(
      "whisper_transcription",
      async (signal) => {
        const startedAt = Date.now();

        let progressPending: Promise<void> | null = null;

        const progressTimer = showDemoProgress
          ? setInterval(() => {
              if (progressPending !== null) {
                return;
              }

              const elapsedSeconds = (Date.now() - startedAt) / 1000;

              const timeoutSeconds = whisperTimeoutMs / 1000;

              progressPending = updateProgress(
                job,
                `文字起こし処理中（経過 ${elapsedSeconds.toFixed(0)}秒 / タイムアウト ${timeoutSeconds.toFixed(0)}秒）…`,
                callbacks,
                discord,
                true,
              ).finally(() => {
                progressPending = null;
              });
            }, 30_000)
          : undefined;

        if (isMp3TranscriptionInput(transcriptionInput)) {
          await monitor?.stageProgress(job.id, "MP3原本を文字起こし中");
        }

        try {
          const service = new CloudflareWhisperTranscriptionService(env.AI, async ({ phase }) => {
            if (phase === "rebuild_started") {
              const detail = "MP3直接decode失敗・フレームのみ再構成して再送中";

              await Promise.all([updateProgress(job, `${detail}…`, callbacks, discord, showDemoProgress), monitor?.stageProgress(job.id, detail)]);
            }
          });

          return await service.transcribe({
            ...transcriptionInput,
            signal,
          });
        } finally {
          if (progressTimer !== undefined) {
            clearInterval(progressTimer);
          }

          /*
           * ここも待ちすぎない。
           * progress update は本処理より重要度が低い。
           */
        }
      },
      whisperTimeoutMs,
    );

    transcriptionResult = transcription;

    if (!(await jobs.isActive(job.id))) {
      console.warn("audio_job_processing_stopped", {
        jobId: job.id,
        stage: "whisper_transcription",
      });

      return "stopped";
    }

    transcriptionText = transcription.text;

    needsTranscriptionCheckpoint = true;
  } else {
    console.info("audio_job_transcription_checkpoint_reused", {
      jobId: job.id,
      attempt,
    });

    await updateProgress(job, "保存済みの文字起こしを再利用して、メタデータ解析を再開しています…", callbacks, discord, showDemoProgress);
  }

  /* ---------------------------------------------------------------------- */
  /* Empty transcription                                                    */
  /* ---------------------------------------------------------------------- */

  if (transcriptionText.trim() === "") {
    await jobs.discardTranscription(job.id);

    await jobs.updateStatus(job.id, "failed", "empty_transcription");

    await notify(job, emptyTranscriptionMessage, callbacks, discord);

    await jobs.clearEphemeral(job.id);

    return "failed";
  }

  /* ---------------------------------------------------------------------- */
  /* Checkpoint                                                             */
  /* ---------------------------------------------------------------------- */

  if (needsTranscriptionCheckpoint) {
    await runJobStage("transcription_checkpoint", () => jobs.saveTranscription(job.id, transcriptionText), stageTimeouts.transcriptionCheckpoint);

    console.info("audio_job_transcription_checkpoint_saved", {
      jobId: job.id,
      attempt,
    });

    if (showDemoProgress && transcriptionResult !== null) {
      const preparation =
        transcriptionResult.audioPreparation?.strategy === "mp3_rebuilt"
          ? `、MP3フレーム再構成で復旧（${transcriptionResult.audioPreparation.submittedBytes} bytes）`
          : "";

      await updateProgress(
        job,
        `文字起こしが完了しました（言語: ${transcriptionResult.language ?? "不明"}、セグメント: ${transcriptionResult.segments.length}件${preparation}）。`,
        callbacks,
        discord,
        true,
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Metadata extraction                                                    */
  /* ---------------------------------------------------------------------- */

  await jobs.updateStatus(job.id, "metadata_extracting");

  const gemini = new GeminiMetadataService(env.GEMINI_API_KEY, env.GEMINI_MODEL);

  /**
   * Gemini は Queue 全体を再実行せず、
   * 同じ transcription に対して最大3回だけ再試行する。
   *
   * GeminiMetadataService が現時点で AbortSignal を受け取らないため、
   * runStage の Promise.race が timeout の責任を持つ。
   *
   * 将来 GeminiMetadataService が signal を受け取るようになれば
   *
   *   operation(signal)
   *
   * 内で signal をそのまま渡せる。
   */
  const runGeminiStage = async <T>(stage: string, operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> => {
    let geminiAttempt = 1;

    while (true) {
      try {
        return await runJobStage(stage, operation, timeoutMs);
      } catch (error) {
        if (error instanceof JobCancellationRequestedError || error instanceof AudioJobProcessingTimeoutError) {
          throw error;
        }

        if (!isRetryableGeminiError(error) || geminiAttempt >= maximumGeminiAttempts) {
          throw error;
        }

        const details = errorDetails(error);

        console.warn("audio_job_gemini_retry", {
          jobId: job.id,
          stage,
          geminiAttempt,
          nextAttempt: geminiAttempt + 1,
          ...details,
        });

        if (showDemoProgress) {
          await updateProgress(
            job,
            `${stage}で一時エラーが発生しました（${details.errorName}: ${details.errorMessage.slice(0, 300)}）。再試行します（${
              geminiAttempt + 1
            }/${maximumGeminiAttempts}）…`,
            callbacks,
            discord,
            true,
          );
        }

        await monitor?.assertNotCancelled(job.id, stage);

        /*
         * retry sleep まで含めて global deadline を確認する。
         */
        const backoffMs = geminiAttempt * 1_000;

        if (remainingJobMs() <= backoffMs) {
          const timeoutError = new AudioJobProcessingTimeoutError(staleAudioJobTimeoutMs);

          tagErrorStage(timeoutError, stage);

          throw timeoutError;
        }

        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));

        geminiAttempt += 1;
      }
    }
  };

  const handleGeminiFailure = async (error: unknown, fallbackStage: string): Promise<"failed" | "stopped"> => {
    if (!(await jobs.isActive(job.id))) {
      console.warn("audio_job_processing_stopped", {
        jobId: job.id,
        stage: fallbackStage,
      });

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

    /*
     * Timeout は上位consumeAudioJobsで統一処理したいので
     * metadata partial に潰さずthrowする。
     */
    if (error instanceof AudioJobProcessingTimeoutError || error instanceof JobCancellationRequestedError) {
      throw error;
    }

    console.warn("audio_job_metadata_rejected", {
      jobId: job.id,
      ...errorDetails(error),
    });

    if (alertsEnabled) {
      await sendAlert(env, discord, job.id, errorStage(error, fallbackStage), error, attempt);
    }

    await jobs.updateStatus(job.id, "partial", "metadata_extraction_failed");

    await notify(job, formatFailure("processing_failed"), callbacks, discord);

    await jobs.clearEphemeral(job.id);

    return "failed";
  };

  /* ---------------------------------------------------------------------- */
  /* Gemini #1: structure analysis                                          */
  /* ---------------------------------------------------------------------- */

  await updateProgress(job, "放送構造を解析しています…", callbacks, discord, showDemoProgress);

  let analysis: Awaited<ReturnType<GeminiMetadataService["analyze"]>>;

  try {
    analysis = await runGeminiStage(
      "gemini_analysis",
      async (_signal) => {
        /*
         * GeminiMetadataService が AbortSignal 対応したら、
         * ここで signal を渡す。
         */
        return gemini.analyze(transcriptionText);
      },
      stageTimeouts.geminiAnalysis,
    );
  } catch (error) {
    return handleGeminiFailure(error, "gemini_analysis");
  }

  if (!(await jobs.isActive(job.id))) {
    console.warn("audio_job_processing_stopped", {
      jobId: job.id,
      stage: "gemini_analysis",
    });

    return "stopped";
  }

  if (showDemoProgress) {
    await updateProgress(
      job,
      `放送構造解析が完了しました（交通案内判定: ${analysis.isTransitAnnouncement}、駅mention: ${analysis.mentions.length}件）。`,
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

  /* ---------------------------------------------------------------------- */
  /* Station candidate search                                               */
  /* ---------------------------------------------------------------------- */

  await updateProgress(job, "地理空間情報を参照しています…", callbacks, discord, showDemoProgress);

  const sequences = groupStationSequences(analysis.mentions).filter(({ role }) => role !== "unknown");

  const stationSearchCache = createD1StationsJobCache();

  const stationSearchStartedAt = Date.now();

  const sequenceSearches: DemoDiagnostics["sequenceSearches"] = await runJobStage(
    "station_candidates_sequences",
    async (signal) => {
      return Promise.all(
        sequences.map(async ({ id, role, mentions, contextMentions }) => {
          if (signal.aborted) {
            throw signal.reason ?? new Error("station search aborted");
          }

          const searchMentions = [...mentions, ...contextMentions];

          const repository = new D1StationsRepository(env.DB, stationSearchCache);

          const service = new StationCandidateService(repository);

          const stationSearch = await service.analyzeMentions(
            searchMentions.map(({ text }) => text),
            {},
            {
              sequenceRole: role,
              destinationContext: contextMentions.length > 0,
              phoneticHints: searchMentions.map(({ phoneticHint }) => phoneticHint ?? null),
            },
          );

          if (signal.aborted) {
            throw signal.reason ?? new Error("station search aborted");
          }

          return {
            id,
            role,
            mentions,
            contextMentions,
            stationSearch,
          };
        }),
      );
    },
    stageTimeouts.stationCandidates,
  );

  /* ---------------------------------------------------------------------- */
  /* Candidate reconciliation                                               */
  /* ---------------------------------------------------------------------- */

  const reconciliationStartedAt = Date.now();

  const stationMentionBindings = reconcileStationMentionCandidates(sequenceSearches.map(({ stationSearch }) => stationSearch));

  const stationSearchPhaseMs = Date.now() - stationSearchStartedAt;

  for (const { id, stationSearch } of sequenceSearches) {
    const metrics = stationSearch.metrics;

    console.info("station_candidates_sequence_summary", {
      jobId: job.id,
      sequenceId: id,

      mentions: metrics.mentions,

      surface_candidate_count: metrics.surfaceCandidateCount,

      phonetic_candidate_count: metrics.phoneticCandidateCount,

      unique_candidate_count: metrics.uniqueCandidateCount,

      line_ids_loaded: metrics.lineIdsLoaded,

      route_hypotheses_generated: metrics.routeHypothesesGenerated,

      route_hypotheses_kept: metrics.routeHypothesesKept,

      graph_search_count: metrics.graphSearchCount,

      fallback_executed: metrics.fallbackExecuted,

      fallback_seed_count: metrics.fallbackSeedCount,

      alignment_route_count: metrics.alignmentRouteCount,

      alignment_comparison_count: metrics.alignmentComparisonCount,

      d1_query_count: metrics.d1QueryCount,

      candidate_generation_ms: metrics.candidateGenerationMs,

      line_lookup_ms: metrics.lineLookupMs,

      hypothesis_generation_ms: metrics.hypothesisGenerationMs,

      graph_search_ms: metrics.graphSearchMs,

      alignment_ms: metrics.alignmentMs,

      reconciliation_ms: metrics.reconciliationMs,

      total_ms: metrics.totalMs,
    });
  }

  console.info("station_candidates_reconciliation_summary", {
    jobId: job.id,
    sequenceCount: sequenceSearches.length,
    bindingCount: stationMentionBindings.size,
    reconciliationMs: Date.now() - reconciliationStartedAt,
  });

  const stationObservations = sequenceSearches.map(({ id, stationSearch }) => ({
    id,
    metrics: stationSearch.metrics,
  }));

  await monitor?.observation(job.id, formatStationCandidateJobProgress(stationObservations, stationSearchPhaseMs));

  const performanceWarning = stationCandidatePerformanceWarning(stationObservations, stationSearchPhaseMs);

  if (alertsEnabled && performanceWarning !== null) {
    await sendAlert(env, discord, job.id, "station_candidates_sequences", new StationCandidatePerformanceWarning(performanceWarning), attempt, "warning");
  }

  const candidates = [
    ...new Map(sequenceSearches.flatMap(({ stationSearch }) => stationSearch.candidates).map((candidate) => [candidate.station.id, candidate])).values(),
  ];

  if (showDemoProgress) {
    const routeCount = sequenceSearches.reduce((sum, sequence) => sum + sequence.stationSearch.routeCandidates.length, 0);

    await updateProgress(
      job,
      `地理空間探索が完了しました（sequence: ${sequenceSearches.length}件、経路候補: ${routeCount}件、駅候補: ${candidates.length}件）。`,
      callbacks,
      discord,
      true,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Gemini #2: normalization                                               */
  /* ---------------------------------------------------------------------- */

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

  await updateProgress(job, "地理空間情報をもとに文字起こし文面を解析します…", callbacks, discord, showDemoProgress);

  let normalization: Awaited<ReturnType<GeminiMetadataService["normalize"]>>;

  try {
    normalization = await runGeminiStage(
      "gemini_normalization",
      async (_signal) => {
        return gemini.normalize(transcriptionText, analysisForNormalization, normalizationSequences);
      },
      stageTimeouts.geminiNormalization,
    );
  } catch (error) {
    return handleGeminiFailure(error, "gemini_normalization");
  }

  if (!(await jobs.isActive(job.id))) {
    console.warn("audio_job_processing_stopped", {
      jobId: job.id,
      stage: "gemini_normalization",
    });

    return "stopped";
  }

  /* ---------------------------------------------------------------------- */
  /* Metadata / filename                                                    */
  /* ---------------------------------------------------------------------- */

  const resolution = resolveStation(candidates, analysis.metadata.station);

  const metadata = applyNormalizedEntitiesToMetadata(
    {
      ...analysis.metadata,
      station: resolution.stationName,
    },
    normalization.entities,
  );

  const filename = generateRailwayFilename(metadata, job.originalFilename);

  if (showDemoProgress) {
    await updateProgress(job, `解析結果を組み立てました（生成ファイル名: ${filename}）。`, callbacks, discord, true);
  }

  if (!(await jobs.isActive(job.id))) {
    console.warn("audio_job_processing_stopped", {
      jobId: job.id,
      stage: "before_clip_save",
    });

    return "stopped";
  }

  /* ---------------------------------------------------------------------- */
  /* Save clip                                                              */
  /* ---------------------------------------------------------------------- */

  await runJobStage(
    "clip_save",
    () =>
      clips.save({
        jobId: job.id,
        clipIndex: 1,
        rawTranscription: transcriptionText,
        normalizedTranscription: normalization.normalizedTranscription,
        metadata,
        resolution,
        generatedFilename: filename,
        createdAt: new Date().toISOString(),
      }),
    stageTimeouts.clipSave,
  );

  /* ---------------------------------------------------------------------- */
  /* Re-download audio if checkpoint reused                                 */
  /* ---------------------------------------------------------------------- */

  if (audio === null) {
    await updateProgress(job, "解析済みの音声ファイルを添付しています…", callbacks, discord, showDemoProgress);

    audio = await runJobStage(
      "attachment_download_for_result",
      () => discord.downloadTemporaryAttachment(attachment, maxAudioBytes(env)),
      stageTimeouts.attachmentDownload,
    );
  }

  if (!(await jobs.isActive(job.id))) {
    console.warn("audio_job_processing_stopped", {
      jobId: job.id,
      stage: "before_result_notification",
    });

    return "stopped";
  }

  /* ---------------------------------------------------------------------- */
  /* Result notification                                                    */
  /* ---------------------------------------------------------------------- */

  const resultFile = {
    data: audio,
    filename,
    contentType: job.contentType,
  };

  const delivered = await runJobStage(
    "result_notification",
    () =>
      resources?.showDemoDiagnostics
        ? notifyDemo(
            job,
            {
              audioInput: {
                filename: job.originalFilename,
                contentType: job.contentType,
                sizeBytes: job.sizeBytes,
                durationSecs: job.durationSecs,
              },

              whisper: {
                model: whisperModel,
                settings: whisperSettings,
                result: transcriptionResult ?? {
                  language: null,
                  text: transcriptionText,
                  segments: [],
                },
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
            },
            callbacks,
            discord,
            resultFile,
          )
        : notify(job, formatAnalysisResult(metadata, normalization.normalizedTranscription, filename), callbacks, discord, resultFile),
    stageTimeouts.resultNotification,
  );

  if (!delivered) {
    const error = new Error("Discord result notification failed");

    tagErrorStage(error, "result_notification");

    throw error;
  }

  /* ---------------------------------------------------------------------- */
  /* Cleanup                                                                */
  /* ---------------------------------------------------------------------- */

  try {
    await runJobStage("ephemeral_cleanup", () => jobs.clearEphemeral(job.id), stageTimeouts.ephemeralCleanup);
  } catch (error) {
    console.error("audio_job_ephemeral_cleanup_failed", {
      jobId: job.id,
      ...errorDetails(error),
    });

    if (alertsEnabled) {
      await sendAlert(env, discord, job.id, "ephemeral_cleanup", error, attempt);
    }
  }

  await runJobStage("completion_status", () => jobs.updateStatus(job.id, "completed"), stageTimeouts.completionStatus);

  return "completed";
}

/* -------------------------------------------------------------------------- */
/* Demo                                                                      */
/* -------------------------------------------------------------------------- */

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

      temporaryReference: {
        url: message.attachment.url,
        expiresAt: null,
      },
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
      get: async () => ({
        token: message.interactionToken,

        expiresAt: "9999-12-31T23:59:59.999Z",
      }),
    },

    clips: {
      save: async () => {},
    },

    sendAlerts: false,

    showDemoDiagnostics: true,
  };
}

async function processDemoMessage(message: DemoAudioJobMessage, env: Env, attempt: number, monitor?: JobMonitor): Promise<"completed" | "failed" | "stopped"> {
  return processJob(demoJob(message), env, attempt, demoResources(message), monitor);
}

/* -------------------------------------------------------------------------- */
/* Queue consumer                                                             */
/* -------------------------------------------------------------------------- */

export async function consumeAudioJobs(batch: MessageBatch<AudioJobMessage>, env: Env): Promise<void> {
  const discord = new DiscordRestClient(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);

  let staleJobsChecked = false;

  for (const message of batch.messages) {
    console.info("audio_job_message_received", {
      queueMessageId: message.id,
      attempt: message.attempts,
    });

    const parsed = AudioJobMessageSchema.safeParse(message.body);

    if (!parsed.success) {
      console.error("audio_job_message_invalid", {
        queueMessageId: message.id,
        attempt: message.attempts,
      });

      message.ack();
      continue;
    }

    /* -------------------------------------------------------------------- */
    /* Demo                                                                 */
    /* -------------------------------------------------------------------- */

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

        const stage = errorStage(error, error instanceof AudioJobProcessingTimeoutError ? "processing_timeout" : "demo_processing");

        if (error instanceof JobCancellationRequestedError) {
          await monitor.transition(job.id, "stopped", error.stage);

          console.info("demo_audio_job_cancelled", {
            interactionId: demoMessage.interactionId,

            queueMessageId: message.id,

            stage: error.stage,
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
          error instanceof AttachmentUnavailableError ? formatFailure("attachment_unavailable") : formatDemoFailure(error, stage, message.attempts),
          resources.callbacks,
          discord,
        );

        await monitor.transition(job.id, error instanceof AudioJobProcessingTimeoutError ? "timed_out" : "failed", stage, error);

        message.ack();
      }

      continue;
    }

    /* -------------------------------------------------------------------- */
    /* Persisted jobs                                                       */
    /* -------------------------------------------------------------------- */

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

      console.info("audio_job_message_acked", {
        jobId: job.id,
        queueMessageId: message.id,
        attempt: message.attempts,
      });

      message.ack();
    } catch (error) {
      const details = errorDetails(error);

      const stage = errorStage(error, error instanceof AudioJobProcessingTimeoutError ? "processing_timeout" : "processing");

      /* ------------------------------------------------------------------ */
      /* Cancellation                                                       */
      /* ------------------------------------------------------------------ */

      if (error instanceof JobCancellationRequestedError) {
        console.info("audio_job_cancelled", {
          jobId: job.id,
          queueMessageId: message.id,
          attempt: message.attempts,
          stage: error.stage,
        });

        await jobs.updateStatus(job.id, "failed", "cancelled");

        await jobs.clearEphemeral(job.id);

        await monitor.transition(job.id, "stopped", error.stage);

        message.ack();
        continue;
      }

      /* ------------------------------------------------------------------ */
      /* Alert                                                              */
      /* ------------------------------------------------------------------ */

      if (
        error instanceof AttachmentUnavailableError ||
        error instanceof AudioJobProcessingTimeoutError ||
        message.attempts === 1 ||
        message.attempts >= maximumQueueAttempts
      ) {
        await sendAlert(env, discord, job.id, stage, error, message.attempts);
      }

      /* ------------------------------------------------------------------ */
      /* Attachment unavailable                                             */
      /* ------------------------------------------------------------------ */

      if (error instanceof AttachmentUnavailableError) {
        const resultAttachmentFailed = stage === "attachment_download_for_result";

        console.error("audio_job_attachment_terminal", {
          jobId: job.id,

          queueMessageId: message.id,

          attempt: message.attempts,

          stage,

          ...details,
        });

        await jobs.updateStatus(job.id, resultAttachmentFailed ? "partial" : "failed", "attachment_unavailable");

        await monitor.transition(job.id, "failed", stage, error);

        await notify(job, formatFailure(resultAttachmentFailed ? "processing_failed" : "attachment_unavailable"), callbacks, discord);

        await jobs.clearEphemeral(job.id);

        console.info("audio_job_message_acked", {
          jobId: job.id,
          queueMessageId: message.id,
          attempt: message.attempts,
        });

        message.ack();
        continue;
      }

      /* ------------------------------------------------------------------ */
      /* Timeout                                                            */
      /* ------------------------------------------------------------------ */

      if (error instanceof AudioJobProcessingTimeoutError) {
        console.error("audio_job_processing_timed_out", {
          jobId: job.id,

          queueMessageId: message.id,

          attempt: message.attempts,

          stage,

          ...details,
        });

        await jobs.updateStatus(job.id, "failed", "processing_timeout");

        await monitor.transition(job.id, "timed_out", stage, error);

        await notify(job, staleJobMessage, callbacks, discord);

        await jobs.clearEphemeral(job.id);

        console.info("audio_job_message_acked", {
          jobId: job.id,
          queueMessageId: message.id,
          attempt: message.attempts,
        });

        message.ack();
        continue;
      }

      /* ------------------------------------------------------------------ */
      /* Queue retry                                                        */
      /* ------------------------------------------------------------------ */

      if (shouldRetryAudioJob(error, message.attempts)) {
        const delaySeconds = Math.min(300, 2 ** message.attempts * 5);

        console.error("audio_job_message_retried", {
          jobId: job.id,

          queueMessageId: message.id,

          attempt: message.attempts,

          delaySeconds,

          stage,

          ...details,
        });

        await jobs.updateStatus(job.id, "queued", "transient_processing_error");

        await monitor.transition(job.id, "retrying", stage, error);

        await updateProgress(
          job,
          `処理中に一時的なエラーが発生しました。再試行を待っています（次回 ${message.attempts + 1}/${maximumQueueAttempts}）…`,
          callbacks,
          discord,
        );

        message.retry({
          delaySeconds,
        });

        continue;
      }

      /* ------------------------------------------------------------------ */
      /* Terminal processing failure                                        */
      /* ------------------------------------------------------------------ */

      console.error("audio_job_processing_terminal", {
        jobId: job.id,

        queueMessageId: message.id,

        attempt: message.attempts,

        stage,

        ...details,
      });

      const latestJob = await jobs.findById(job.id);

      const terminalStatus = latestJob !== null && latestJob.transcriptionText !== null ? "partial" : "failed";

      await jobs.updateStatus(job.id, terminalStatus, "processing_failed");

      await monitor.transition(job.id, "failed", stage, error);

      await notify(job, formatFailure("processing_failed"), callbacks, discord);

      await jobs.clearEphemeral(job.id);

      console.info("audio_job_message_acked", {
        jobId: job.id,
        queueMessageId: message.id,
        attempt: message.attempts,
      });

      message.ack();
    }
  }
}
