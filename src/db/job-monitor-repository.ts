import { z } from "zod";

export const jobMonitorStates = [
  "running",
  "retrying",
  "cancel_requested",
  "stopped",
  "completed",
  "failed",
  "timed_out",
] as const;
export type JobMonitorState = (typeof jobMonitorStates)[number];

const JobMonitorRowSchema = z.object({
  job_id: z.string(),
  channel_id: z.string(),
  message_id: z.string().nullable(),
  current_stage: z.string(),
  stage_detail: z.string().nullable(),
  state: z.enum(jobMonitorStates),
  queue_attempt: z.number().int(),
  user_id: z.string().nullable(),
  filename: z.string(),
  size_bytes: z.number().int(),
  started_at: z.string(),
  stage_started_at: z.string(),
  stage_timeout_at: z.string().nullable(),
  updated_at: z.string(),
  cancellation_requested_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  error_message: z.string().nullable(),
  observations: z.string().default(""),
});

export type JobMonitorRecord = {
  jobId: string;
  channelId: string;
  messageId: string | null;
  currentStage: string;
  stageDetail: string | null;
  state: JobMonitorState;
  queueAttempt: number;
  userId: string | null;
  filename: string;
  sizeBytes: number;
  startedAt: string;
  stageStartedAt: string;
  stageTimeoutAt: string | null;
  updatedAt: string;
  cancellationRequestedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  observations: string;
};

function toRecord(input: unknown): JobMonitorRecord {
  const row = JobMonitorRowSchema.parse(input);
  return {
    jobId: row.job_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    currentStage: row.current_stage,
    stageDetail: row.stage_detail,
    state: row.state,
    queueAttempt: row.queue_attempt,
    userId: row.user_id,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    startedAt: row.started_at,
    stageStartedAt: row.stage_started_at,
    stageTimeoutAt: row.stage_timeout_at,
    updatedAt: row.updated_at,
    cancellationRequestedAt: row.cancellation_requested_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    observations: row.observations,
  };
}

export class JobMonitorRepository {
  constructor(private readonly db: D1Database) {}

  async find(jobId: string): Promise<JobMonitorRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM job_monitor_messages WHERE job_id = ?")
      .bind(jobId)
      .first();
    return row === null ? null : toRecord(row);
  }

  async ensure(input: {
    jobId: string;
    channelId: string;
    queueAttempt: number;
    userId: string | null;
    filename: string;
    sizeBytes: number;
    now: string;
  }): Promise<JobMonitorRecord> {
    await this.db
      .prepare(
        `
      INSERT INTO job_monitor_messages (
        job_id, channel_id, current_stage, state, queue_attempt, user_id,
        filename, size_bytes, started_at, stage_started_at, updated_at
      ) VALUES (?, ?, 'queue_start', 'running', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        queue_attempt = excluded.queue_attempt,
        state = CASE
          WHEN job_monitor_messages.state IN ('completed', 'failed', 'stopped', 'timed_out')
            THEN job_monitor_messages.state
          WHEN job_monitor_messages.state = 'cancel_requested' THEN 'cancel_requested'
          ELSE 'running'
        END,
        error_message = CASE
          WHEN job_monitor_messages.state = 'cancel_requested' THEN job_monitor_messages.error_message
          ELSE NULL
        END,
        updated_at = excluded.updated_at
    `,
      )
      .bind(
        input.jobId,
        input.channelId,
        input.queueAttempt,
        input.userId,
        input.filename,
        input.sizeBytes,
        input.now,
        input.now,
        input.now,
      )
      .run();
    const record = await this.find(input.jobId);
    if (record === null)
      throw new Error("Job monitor insert/read consistency failure");
    return record;
  }

  async setMessageId(
    jobId: string,
    messageId: string,
    now: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `
      UPDATE job_monitor_messages SET message_id = COALESCE(message_id, ?), updated_at = ? WHERE job_id = ?
    `,
      )
      .bind(messageId, now, jobId)
      .run();
  }

  async stageStarted(
    jobId: string,
    stage: string,
    now: string,
    timeoutAt: string | null,
  ): Promise<void> {
    await this.db
      .prepare(
        `
      UPDATE job_monitor_messages
      SET current_stage = ?, stage_detail = NULL, stage_started_at = ?, stage_timeout_at = ?,
          state = CASE WHEN state = 'retrying' THEN 'running' ELSE state END, updated_at = ?
      WHERE job_id = ? AND state IN ('running', 'retrying', 'cancel_requested')
    `,
      )
      .bind(stage, now, timeoutAt, now, jobId)
      .run();
  }

  async updateStageDetail(
    jobId: string,
    detail: string,
    now: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `
      UPDATE job_monitor_messages SET stage_detail = ?, updated_at = ?
      WHERE job_id = ? AND state IN ('running', 'cancel_requested')
    `,
      )
      .bind(detail, now, jobId)
      .run();
  }

  async appendObservation(
    jobId: string,
    detail: string,
    now: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `
      UPDATE job_monitor_messages SET
        observations = substr(
          CASE WHEN observations = '' THEN ? ELSE observations || '\n\n' || ? END,
          -600
        ),
        updated_at = ?
      WHERE job_id = ?
    `,
      )
      .bind(detail, detail, now, jobId)
      .run();
  }

  async requestCancellation(
    jobId: string,
    now: string,
  ): Promise<JobMonitorRecord | null> {
    await this.db
      .prepare(
        `
      UPDATE job_monitor_messages
      SET state = 'cancel_requested', cancellation_requested_at = COALESCE(cancellation_requested_at, ?), updated_at = ?
      WHERE job_id = ? AND state IN ('running', 'retrying', 'cancel_requested')
    `,
      )
      .bind(now, now, jobId)
      .run();
    return this.find(jobId);
  }

  async isCancellationRequested(jobId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `
      SELECT 1 AS requested FROM job_monitor_messages
      WHERE job_id = ? AND state = 'cancel_requested'
    `,
      )
      .bind(jobId)
      .first();
    return row !== null;
  }

  async transition(
    jobId: string,
    state: JobMonitorState,
    input: {
      now: string;
      stage?: string;
      errorMessage?: string | null;
    },
  ): Promise<JobMonitorRecord | null> {
    const terminal = ["stopped", "completed", "failed", "timed_out"].includes(
      state,
    );
    await this.db
      .prepare(
        `
      UPDATE job_monitor_messages SET
        state = ?,
        current_stage = COALESCE(?, current_stage),
        error_message = ?,
        completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
        updated_at = ?
      WHERE job_id = ?
    `,
      )
      .bind(
        state,
        input.stage ?? null,
        input.errorMessage ?? null,
        terminal ? 1 : 0,
        input.now,
        input.now,
        jobId,
      )
      .run();
    return this.find(jobId);
  }
}
