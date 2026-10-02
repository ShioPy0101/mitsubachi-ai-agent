import { formatPublicFailure } from "../discord/presentation";
import { newExecutionContext } from "../pipeline/modes";
import { measuredDatabase } from "../db/database-metrics";
import { z } from "zod";

import { classifyFailure } from "../pipeline/failures";
import { jobProcessingTimeoutMs } from "./processing-timeout";

import { CallbackSecretsRepository } from "../db/callback-secrets-repository";
import { JobsRepository } from "../db/jobs-repository";

import {
  AttachmentUnavailableError,
  DiscordRestClient,
} from "../discord/rest-client";

import { formatFailure } from "../discord/messages";

import { WhisperAudioDecodeError } from "../transcription/workers-ai";

import { AudioJobProcessingTimeoutError } from "./processing-timeout";

import type { AudioJobMessage } from "./types";

import { createJobMonitor, JobCancellationRequestedError } from "./job-monitor";

import { processJob } from "../pipeline/audio-pipeline";
import {
  formatDemoFailure,
  notify,
  sendAlert,
  staleJobMessage,
  updateProgress,
} from "../pipeline/delivery";
import { errorDetails, errorStage } from "../pipeline/stage-runner";
import { stopStaleAudioJobs } from "../pipeline/stale-recovery";
export { runStage } from "../pipeline/stage-runner";
export { stopStaleAudioJobs } from "../pipeline/stale-recovery";
const PersistedAudioJobMessageSchema = z.object({
  kind: z.literal("persisted").optional(),
  jobId: z.string().uuid(),
});

const AudioJobMessageSchema = PersistedAudioJobMessageSchema;

const terminalStatuses = new Set(["completed", "partial", "failed"]);
const maximumQueueAttempts = 5;
const noPipelineRetryStages = new Set([
  "transcription_checkpoint",
  "result_notification",
  "completion_status",
]);
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

  const stage = errorStage(error, "processing");
  const policy = classifyFailure(error, stage).retryPolicy;
  return (
    !noPipelineRetryStages.has(stage) &&
    policy !== "never" &&
    (policy !== "limited" || attempt < 2)
  );
}

export async function consumeAudioJobs(
  batch: MessageBatch<AudioJobMessage>,
  env: Env,
): Promise<void> {
  const discord = new DiscordRestClient(
    env.DISCORD_BOT_TOKEN,
    env.DISCORD_APPLICATION_ID,
  );

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

    if (!staleJobsChecked) {
      await stopStaleAudioJobs(env);

      staleJobsChecked = true;
    }

    const context = newExecutionContext("public");
    const jobEnv = {
      ...env,
      DB: measuredDatabase(env.DB, context.databaseMetrics),
    };
    const jobs = new JobsRepository(jobEnv.DB);

    const callbacks = new CallbackSecretsRepository(jobEnv.DB);

    const monitor = createJobMonitor(jobEnv, discord);

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

    if (job.presentationMode === "demo") context.presentationMode = "demo";
    if (message.attempts > 1) {
      // A platform termination may bypass catch/finally. Capture durable
      // previous progress before the next attempt overwrites the stage.
      console.warn("audio_job_redelivered", {
        jobId: job.id,
        queueMessageId: message.id,
        attempt: message.attempts,
        previousStatus: job.status,
        previousStage: job.stage ?? null,
        previousStageStartedAt: job.stageStartedAt ?? null,
        previousFailureCode: job.failureCode ?? null,
        previousErrorMessage: job.errorMessage,
        hasTranscriptionCheckpoint: job.transcriptionText !== null,
        deadlineAt: job.deadlineAt ?? null,
        interruptionCause: "unknown",
      });
    }
    try {
      const now = new Date().toISOString();
      const deadline = new Date(
        Date.now() + jobProcessingTimeoutMs(job.durationSecs),
      ).toISOString();
      await jobs.beginProcessing(job.id, now, deadline);
      job.processingStartedAt ??= now;
      job.deadlineAt ??= deadline;
      await monitor.start(job, message.attempts);

      const outcome = await processJob(
        job,
        jobEnv,
        message.attempts,
        undefined,
        monitor,
        context,
      );

      await monitor.transition(
        job.id,
        outcome === "completed" ? "completed" : outcome,
      );

      console.info("audio_job_database_metrics", {
        jobId: job.id,
        ...context.databaseMetrics,
      });
      console.info("audio_job_message_acked", {
        jobId: job.id,
        queueMessageId: message.id,
        attempt: message.attempts,
      });

      message.ack();
    } catch (error) {
      const details = errorDetails(error);

      const stage = errorStage(error, "processing");

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
        const resultAttachmentFailed =
          stage === "attachment_download_for_result";

        console.error("audio_job_attachment_terminal", {
          jobId: job.id,

          queueMessageId: message.id,

          attempt: message.attempts,

          stage,

          ...details,
        });

        await jobs.updateStatus(
          job.id,
          resultAttachmentFailed ? "partial" : "failed",
          "attachment_unavailable",
        );

        await monitor.transition(job.id, "failed", stage, error);

        await notify(
          job,
          formatFailure(
            resultAttachmentFailed
              ? "processing_failed"
              : "attachment_unavailable",
          ),
          callbacks,
          discord,
        );

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

        await jobs.updateStatus(
          job.id,
          "failed",
          classifyFailure(error, stage).failureCode,
        );

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

      const terminalStatus =
        latestJob !== null && latestJob.transcriptionText !== null
          ? "partial"
          : "failed";

      await jobs.updateStatus(
        job.id,
        terminalStatus,
        classifyFailure(error, stage).failureCode,
      );

      await monitor.transition(job.id, "failed", stage, error);

      await notify(
        job,
        job.presentationMode === "demo"
          ? formatDemoFailure(error, stage, message.attempts)
          : formatPublicFailure(classifyFailure(error, stage).failureCode),
        callbacks,
        discord,
      );

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
