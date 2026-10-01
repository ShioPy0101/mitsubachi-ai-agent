import { classifyFailure } from "./failures";
import railwayManifest from "../../data/generated/manifest.json";
import {
  StaticRailwayRepository,
  createStaticRailwayJobCache,
} from "../stations/static-repository";
import { railwayIndexes } from "../stations/static-data";
import { newExecutionContext, type ExecutionContext } from "./modes";
import {
  stationNameOccurrences,
  attachSpeechSegmentProvenance,
} from "../railway/semantic";

import {
  JobDeadlineExceededError,
  jobProcessingTimeoutMs,
} from "../jobs/processing-timeout";
import type { StationCorrectionResult } from "../stations/correction-engine";
import { StationCorrectionEngine } from "../stations/correction-engine";
import {
  NaturalLanguageNormalizationStage,
  SemanticAnalysisStage,
} from "./ai-stages";
import { D1PipelineCheckpoints } from "./checkpoints";
import { assembleResult } from "./result-assembly";
import { newJobTimingMetrics, timingField } from "./timing";
import { transcribeStage } from "./transcription-stage";

import { CallbackSecretsRepository } from "../db/callback-secrets-repository";
import { ClipsRepository } from "../db/clips-repository";
import { JobsRepository } from "../db/jobs-repository";

import { DiscordRestClient } from "../discord/rest-client";

import { formatAnalysisResult, formatFailure } from "../discord/messages";

import {
  GeminiMetadataService,
  GeminiSafetyBlockedError,
  isRetryableGeminiError,
} from "../metadata/gemini";

import type { TranscriptionResult } from "../transcription/service";

import { whisperModel, whisperSettings } from "../transcription/workers-ai";

import { AudioJobProcessingTimeoutError } from "../jobs/processing-timeout";

import type { AudioJob } from "../jobs/types";

import {
  JobCancellationRequestedError,
  type JobMonitor,
} from "../jobs/job-monitor";

import {
  formatStationCandidateJobProgress,
  StationCandidatePerformanceWarning,
  stationCandidatePerformanceWarning,
} from "../jobs/station-observability";

import {
  attachmentFor,
  maxAudioBytes,
  notify,
  notifyDemo,
  rejectedContentMessage,
  sendAlert,
  updateProgress,
} from "./delivery";
import { stageTimeouts, type ProcessingResources } from "./resources";
import {
  errorDetails,
  errorStage,
  runStage,
  tagErrorStage,
} from "./stage-runner";
const maximumGeminiAttempts = 3;
export async function processJob(
  job: AudioJob,
  env: Env,
  attempt: number,
  resources?: ProcessingResources,
  monitor?: JobMonitor,
  executionContext: ExecutionContext = newExecutionContext(
    job.presentationMode === "demo" ? "demo" : "public",
  ),
): Promise<"completed" | "failed" | "stopped"> {
  const jobs = resources?.jobs ?? new JobsRepository(env.DB);

  const callbacks =
    resources?.callbacks ?? new CallbackSecretsRepository(env.DB);

  const clips = resources?.clips ?? new ClipsRepository(env.DB);

  const checkpoints = new D1PipelineCheckpoints(env.DB, job.id);
  const timing = newJobTimingMetrics();
  const alertsEnabled = resources?.sendAlerts ?? true;

  const showDemoProgress =
    resources?.showDemoDiagnostics ?? job.presentationMode === "demo";

  const discord = new DiscordRestClient(
    env.DISCORD_BOT_TOKEN,
    env.DISCORD_APPLICATION_ID,
  );

  /*
   * Queue再試行の場合も元の startedAt を基準にする。
   *
   * demo は startedAt=null なので processJob 呼び出し時刻を採用する。
   */
  const persistedStartMs = Date.parse(job.processingStartedAt ?? "");

  const processStartedAt = Number.isFinite(persistedStartMs)
    ? persistedStartMs
    : Date.now();

  const jobTimeoutMs = jobProcessingTimeoutMs(job.durationSecs);
  const globalDeadlineAt = job.deadlineAt
    ? Date.parse(job.deadlineAt)
    : processStartedAt + jobTimeoutMs;

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
  const runJobStage = async <T>(
    stage: string,
    operation: (signal: AbortSignal) => Promise<T>,
    stageTimeoutMs?: number,
  ): Promise<T> => {
    if (!(await jobs.isActive(job.id)))
      throw new JobCancellationRequestedError(job.id, stage);
    await jobs.setStage?.(job.id, stage);
    const remaining = remainingJobMs();

    if (remaining <= 0) {
      const error = new JobDeadlineExceededError(jobTimeoutMs);

      tagErrorStage(error, stage);
      console.error("audio_job_timeout", {
        jobId: job.id,
        timeoutKind: "job_deadline",
        stage,
        createdAt: job.createdAt,
        processingStartedAt: new Date(processStartedAt).toISOString(),
        stageStartedAt: new Date().toISOString(),
        deadlineAt: new Date(globalDeadlineAt).toISOString(),
        now: new Date().toISOString(),
        elapsedJobMs: Date.now() - processStartedAt,
        elapsedStageMs: 0,
        jobTimeoutMs,
        stageTimeoutMs,
      });
      return Promise.reject(error);
    }

    const effectiveTimeout =
      stageTimeoutMs === undefined
        ? remaining
        : Math.min(stageTimeoutMs, remaining);

    const stageStartedAt = Date.now();
    try {
      const result = await runStage(
        job.id,
        stage,
        operation,
        monitor,
        effectiveTimeout,
      );
      if (stage !== "completion_status" && !(await jobs.isActive(job.id)))
        throw new JobCancellationRequestedError(job.id, stage);
      return result;
    } catch (error) {
      if (error instanceof AudioJobProcessingTimeoutError) {
        const timeout =
          Date.now() >= globalDeadlineAt
            ? new JobDeadlineExceededError(jobTimeoutMs)
            : error;
        tagErrorStage(timeout, stage);
        console.error("audio_job_timeout", {
          jobId: job.id,
          timeoutKind: timeout.timeoutKind,
          stage,
          createdAt: job.createdAt,
          processingStartedAt: new Date(processStartedAt).toISOString(),
          stageStartedAt: new Date(stageStartedAt).toISOString(),
          deadlineAt: new Date(globalDeadlineAt).toISOString(),
          now: new Date().toISOString(),
          elapsedJobMs: Date.now() - processStartedAt,
          elapsedStageMs: Date.now() - stageStartedAt,
          jobTimeoutMs,
          stageTimeoutMs,
        });
        throw timeout;
      }
      throw error;
    } finally {
      const field = timingField[stage];
      if (field) timing[field] += Date.now() - stageStartedAt;
      timing.totalMs = Date.now() - processStartedAt;
    }
  };

  const attachment = attachmentFor(job);

  let audio: ArrayBuffer | null = null;

  let transcriptionText = job.transcriptionText;

  let transcriptionResult: TranscriptionResult | null = null;

  /* ---------------------------------------------------------------------- */
  /* Whisper                                                                */
  /* ---------------------------------------------------------------------- */

  const speech = await transcribeStage(
    job,
    env,
    attempt,
    jobs,
    callbacks,
    discord,
    showDemoProgress,
    runJobStage,
    monitor,
  );
  if (speech.outcome !== "ready") return speech.outcome;
  audio = speech.audio;
  transcriptionText = speech.transcriptionText!;
  transcriptionResult = speech.transcriptionResult;
  // Retain provider segment boundaries when downstream stages retry without
  // running Whisper again. The immutable raw transcription stays separate.
  await runJobStage(
    "transcription_provenance",
    async () => {
      if (transcriptionResult)
        await checkpoints.write(
          "speech",
          transcriptionText,
          transcriptionResult,
        );
      else
        transcriptionResult = await checkpoints.read<TranscriptionResult>(
          "speech",
          transcriptionText,
        );
    },
    stageTimeouts.transcriptionCheckpoint,
  );

  /* ---------------------------------------------------------------------- */
  /* Metadata extraction                                                    */
  /* ---------------------------------------------------------------------- */

  await jobs.updateStatus(job.id, "metadata_extracting");

  const gemini = new GeminiMetadataService(
    env.GEMINI_API_KEY,
    env.GEMINI_MODEL,
  );

  // Provider retry retains the same input and forwards the AbortSignal.
  const runGeminiStage = async <T>(
    stage: string,
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<T> => {
    let geminiAttempt = 1;

    while (true) {
      try {
        return await runJobStage(stage, operation, timeoutMs);
      } catch (error) {
        if (
          error instanceof JobCancellationRequestedError ||
          error instanceof AudioJobProcessingTimeoutError
        ) {
          throw error;
        }

        if (
          !isRetryableGeminiError(error) ||
          geminiAttempt >= maximumGeminiAttempts
        ) {
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
          const timeoutError = new JobDeadlineExceededError(jobTimeoutMs);

          tagErrorStage(timeoutError, stage);

          throw timeoutError;
        }

        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));

        geminiAttempt += 1;
      }
    }
  };

  const handleGeminiFailure = async (
    error: unknown,
    fallbackStage: string,
  ): Promise<"failed" | "stopped"> => {
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

      await jobs.updateStatus(job.id, "failed", "content_policy_blocked");

      await notify(job, rejectedContentMessage, callbacks, discord);

      await jobs.clearEphemeral(job.id);

      return "failed";
    }

    /*
     * Timeout は上位consumeAudioJobsで統一処理したいので
     * metadata partial に潰さずthrowする。
     */
    if (
      error instanceof AudioJobProcessingTimeoutError ||
      error instanceof JobCancellationRequestedError
    ) {
      throw error;
    }

    if (isRetryableGeminiError(error)) throw error;
    if (
      classifyFailure(error, fallbackStage).failureCode === "database_failed"
    ) {
      tagErrorStage(error, "pipeline_checkpoint");
      throw error;
    }

    console.warn("audio_job_metadata_rejected", {
      jobId: job.id,
      ...errorDetails(error),
    });

    if (alertsEnabled) {
      await sendAlert(
        env,
        discord,
        job.id,
        errorStage(error, fallbackStage),
        error,
        attempt,
      );
    }

    await jobs.updateStatus(
      job.id,
      "partial",
      classifyFailure(error, fallbackStage).failureCode,
    );

    await notify(job, formatFailure("processing_failed"), callbacks, discord);

    await jobs.clearEphemeral(job.id);

    return "failed";
  };

  /* ---------------------------------------------------------------------- */
  /* Gemini #1: structure analysis                                          */
  /* ---------------------------------------------------------------------- */

  await updateProgress(
    job,
    "放送構造を解析しています…",
    callbacks,
    discord,
    showDemoProgress,
  );

  let analysis: Awaited<ReturnType<GeminiMetadataService["analyze"]>>;

  try {
    const analysisKey = `${env.GEMINI_MODEL}:semantic-v4:${transcriptionText}`;
    const cachedAnalysis = await checkpoints.read<typeof analysis>(
      "analysis",
      analysisKey,
    );
    analysis =
      cachedAnalysis ??
      (await runGeminiStage(
        "gemini_analysis",
        async (_signal) => {
          // Provider adapter receives the stage signal.
          return new SemanticAnalysisStage(gemini).run(
            transcriptionText,
            _signal,
          );
        },
        stageTimeouts.geminiAnalysis,
      ));
    if (analysis.semantic && transcriptionResult)
      analysis.semantic = attachSpeechSegmentProvenance(
        analysis.semantic,
        transcriptionResult.segments,
      );
    if (!cachedAnalysis)
      await checkpoints.write("analysis", analysisKey, {
        ...analysis,
        diagnostics: {
          prompt: "checkpoint",
          request: {},
          response: null,
          responseText: "checkpoint",
        },
      });
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

    await jobs.updateStatus(job.id, "failed", "non_transit_content");

    await notify(job, rejectedContentMessage, callbacks, discord);

    await jobs.clearEphemeral(job.id);

    return "failed";
  }

  /* ---------------------------------------------------------------------- */
  /* Station candidate search                                               */
  /* ---------------------------------------------------------------------- */

  await updateProgress(
    job,
    "地理空間情報を参照しています…",
    callbacks,
    discord,
    showDemoProgress,
  );

  const railwayCache = createStaticRailwayJobCache();
  const correctionKey =
    `static:${railwayManifest.sourceSha256}:engine-v5-reading-ties:` +
    transcriptionText +
    "\n" +
    analysis.mentions
      .map(
        (m) =>
          `${m.id}:${m.role}:${m.sequenceId}:${m.phoneticHint ?? ""}:${m.language ?? ""}:${m.equivalentEventGroupId ?? ""}`,
      )
      .join("|");
  const cachedCorrection = await checkpoints.read<StationCorrectionResult>(
    "correction",
    correctionKey,
  );
  const correction =
    cachedCorrection ??
    (await runJobStage(
      "station_candidates_sequences",
      (signal) =>
        new StationCorrectionEngine(
          () => new StaticRailwayRepository(railwayIndexes, railwayCache),
        ).run(
          {
            transcription: transcriptionText,
            mentions: analysis.mentions,
            context: {},
          },
          signal,
        ),
      stageTimeouts.stationCandidates,
    ));
  if (!cachedCorrection)
    await checkpoints.write("correction", correctionKey, {
      ...correction,
      bindings: undefined,
    });
  timing.stationReconciliationMs = correction.metrics.reconciliationMs;
  const { sequenceSearches, candidates } = correction;
  const stationSearchPhaseMs = correction.metrics.totalMs;
  const stationObservations = sequenceSearches.map(({ id, stationSearch }) => ({
    id,
    metrics: stationSearch.metrics,
  }));
  console.info("station_correction_summary", {
    jobId: job.id,
    funnel: correction.funnel,
    metrics: correction.metrics,
    unresolvedMentions: correction.unresolvedMentions,
  });
  await monitor?.observation(
    job.id,
    formatStationCandidateJobProgress(
      stationObservations,
      stationSearchPhaseMs,
    ),
  );
  const performanceWarning = stationCandidatePerformanceWarning(
    stationObservations,
    stationSearchPhaseMs,
  );
  if (alertsEnabled && performanceWarning !== null)
    await sendAlert(
      env,
      discord,
      job.id,
      "station_candidates_sequences",
      new StationCandidatePerformanceWarning(performanceWarning),
      attempt,
      "warning",
    );

  if (showDemoProgress) {
    const routeCount = sequenceSearches.reduce(
      (sum, sequence) => sum + sequence.stationSearch.routeCandidates.length,
      0,
    );

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

  await updateProgress(
    job,
    "地理空間情報をもとに文字起こし文面を解析します…",
    callbacks,
    discord,
    showDemoProgress,
  );

  let normalization: Awaited<ReturnType<GeminiMetadataService["normalize"]>>;

  try {
    normalization = await runGeminiStage(
      "gemini_normalization",
      async (_signal) => {
        return new NaturalLanguageNormalizationStage(gemini).run(
          transcriptionText,
          analysis,
          correction,
          _signal,
        );
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

  const { resolution, metadata, filename } = assembleResult(
    analysis,
    correction,
    normalization,
    job.originalFilename,
  );

  if (showDemoProgress) {
    await updateProgress(
      job,
      `解析結果を組み立てました（生成ファイル名: ${filename}）。`,
      callbacks,
      discord,
      true,
    );
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
        railwayDataVersion: railwayManifest.sourceSha256,
        generatedFilename: filename,
        createdAt: new Date().toISOString(),
      }),
    stageTimeouts.clipSave,
  );

  /* ---------------------------------------------------------------------- */
  /* Re-download audio if checkpoint reused                                 */
  /* ---------------------------------------------------------------------- */

  if (audio === null) {
    await updateProgress(
      job,
      "解析済みの音声ファイルを添付しています…",
      callbacks,
      discord,
      showDemoProgress,
    );

    audio = await runJobStage(
      "attachment_download_for_result",
      (signal) =>
        discord.downloadTemporaryAttachment(
          attachment,
          maxAudioBytes(env),
          signal,
        ),
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
      showDemoProgress
        ? notifyDemo(
            job,
            {
              executionContext,
              jobTiming: timing,
              correctionFunnel: correction.funnel,
              unresolvedMentions: correction.unresolvedMentions,
              injectionDiagnostic:
                /ignore.*instructions|指示.*無視|SYSTEM:|ASSISTANT:|<\/transcription>|\{"/iu.test(
                  transcriptionText,
                ),
              missedMentionSurfaces: stationNameOccurrences(
                transcriptionText,
              ).filter(
                (word) => !analysis.mentions.some((m) => m.text.includes(word)),
              ),
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
                normalizationObservation:
                  normalization.normalizationObservation,
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
        : notify(
            job,
            formatAnalysisResult(
              metadata,
              normalization.normalizedTranscription,
              filename,
            ),
            callbacks,
            discord,
            resultFile,
          ),
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
    await runJobStage(
      "ephemeral_cleanup",
      () => jobs.clearEphemeral(job.id),
      stageTimeouts.ephemeralCleanup,
    );
  } catch (error) {
    console.error("audio_job_ephemeral_cleanup_failed", {
      jobId: job.id,
      ...errorDetails(error),
    });

    if (alertsEnabled) {
      await sendAlert(
        env,
        discord,
        job.id,
        "ephemeral_cleanup",
        error,
        attempt,
      );
    }
  }

  await runJobStage(
    "completion_status",
    () => jobs.updateStatus(job.id, "completed"),
    stageTimeouts.completionStatus,
  );

  timing.totalMs = Date.now() - processStartedAt;
  console.info("audio_job_timing", { jobId: job.id, ...timing });
  if (showDemoProgress)
    await updateProgress(
      job,
      `job timing: ${JSON.stringify(timing)}`,
      callbacks,
      discord,
      true,
    );
  return "completed";
}
