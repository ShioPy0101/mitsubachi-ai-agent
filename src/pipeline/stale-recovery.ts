import { jobProcessingTimeoutMs } from "../jobs/processing-timeout";

import { CallbackSecretsRepository } from "../db/callback-secrets-repository";
import { JobsRepository } from "../db/jobs-repository";

import { DiscordRestClient } from "../discord/rest-client";

import { audioJobElapsedMs } from "../jobs/staleness";

import { createJobMonitor } from "../jobs/job-monitor";

import { notify, sendAlert, staleJobMessage } from "./delivery";
import { errorDetails } from "./stage-runner";
export async function stopStaleAudioJobs(
  env: Env,
  now = new Date(),
): Promise<number> {
  const jobs = new JobsRepository(env.DB);

  const callbacks = new CallbackSecretsRepository(env.DB);

  const discord = new DiscordRestClient(
    env.DISCORD_BOT_TOKEN,
    env.DISCORD_APPLICATION_ID,
  );

  const monitor = createJobMonitor(env, discord);

  const cutoff = now.toISOString();

  const staleJobs = await jobs.findStaleActive(cutoff);

  let stopped = 0;

  for (const job of staleJobs) {
    const elapsedMs = audioJobElapsedMs(
      job.createdAt,
      job.processingStartedAt ?? null,
      now,
    );

    if (!job.deadlineAt || Date.parse(job.deadlineAt) > now.getTime()) {
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

    const didStop = await jobs.failIfStaleActive(
      job.id,
      cutoff,
      "job_deadline_exceeded",
      now.toISOString(),
    );

    if (!didStop) {
      continue;
    }

    stopped += 1;

    const error = new Error(
      `audio job exceeded persisted deadline ${job.deadlineAt} ` +
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
      timeoutKind: "stale_recovery",
      stage: job.stage,
      createdAt: job.createdAt,
      processingStartedAt: job.processingStartedAt,
      stageStartedAt: job.stageStartedAt,
      deadlineAt: job.deadlineAt,
      now: now.toISOString(),
      elapsedJobMs: elapsedMs,
      elapsedStageMs: job.stageStartedAt
        ? now.getTime() - Date.parse(job.stageStartedAt)
        : null,
      jobTimeoutMs: jobProcessingTimeoutMs(job.durationSecs),
      stageTimeoutMs: null,
    });

    await monitor.transition(
      job.id,
      "timed_out",
      job.stage ?? "processing",
      error,
    );

    await sendAlert(env, discord, job.id, "job_deadline_exceeded", error);

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
