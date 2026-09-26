import { z } from "zod";
import { jobStatuses, type AudioJob, type JobStatus, type NewAudioJob } from "../jobs/types";

const JobRowSchema = z.object({
  id: z.string(),
  guild_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  interaction_id: z.string(),
  attachment_id: z.string(),
  temporary_url: z.string().nullable(),
  temporary_expires_at: z.string().nullable(),
  original_filename: z.string(),
  content_type: z.string().nullable(),
  size_bytes: z.number().int(),
  duration_secs: z.number().nullable(),
  status: z.enum(jobStatuses),
  error_message: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});

type JobRow = z.output<typeof JobRowSchema>;

function toJob(rowInput: unknown): AudioJob {
  const row = JobRowSchema.parse(rowInput);
  const common = {
    id: row.id,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    durationSecs: row.duration_secs,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
  return {
    ...common,
    source: {
      type: "interaction",
      guildId: row.guild_id,
      channelId: row.channel_id,
      interactionId: row.interaction_id,
      attachmentId: row.attachment_id,
      temporaryReference:
        row.temporary_url === null ? null : { url: row.temporary_url, expiresAt: row.temporary_expires_at },
    },
  };
}

const selectJobSql = `
  SELECT j.*, r.url AS temporary_url, r.expires_at AS temporary_expires_at
  FROM audio_jobs j
  LEFT JOIN ephemeral_attachment_references r ON r.job_id = j.id
`;

export class JobsRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: NewAudioJob, now: string): Promise<{ job: AudioJob; created: boolean }> {
    const id = crypto.randomUUID();
    const source = input.source;
    const result = await this.db
      .prepare(`
        INSERT OR IGNORE INTO audio_jobs (
          id, guild_id, channel_id, interaction_id, attachment_id,
          original_filename, content_type, size_bytes, duration_secs, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
      `)
      .bind(
        id,
        source.guildId,
        source.channelId,
        source.interactionId,
        source.attachmentId,
        input.originalFilename,
        input.contentType,
        input.sizeBytes,
        input.durationSecs,
        now,
      )
      .run();
    const created = result.meta.changes === 1;
    if (created) {
      const statements = [
        this.db
          .prepare("INSERT INTO ephemeral_attachment_references (job_id, attachment_id, url, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(id, source.attachmentId, source.temporaryReference?.url ?? "", source.temporaryReference?.expiresAt ?? null, now),
      ];
      if (input.interactionCallback !== undefined) {
        statements.push(
          this.db
            .prepare("INSERT INTO interaction_callback_secrets (interaction_id, job_id, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(source.interactionId, id, input.interactionCallback.token, input.interactionCallback.expiresAt, now),
        );
      }
      try {
        await this.db.batch(statements);
      } catch (error) {
        await this.db.prepare("DELETE FROM audio_jobs WHERE id = ?").bind(id).run();
        throw error;
      }
    }
    const job = created
      ? await this.findById(id)
      : await this.findByInteractionId(source.interactionId);
    if (job === null) throw new Error("Job insert/read consistency failure");
    return { job, created };
  }

  async findById(id: string): Promise<AudioJob | null> {
    const row = await this.db.prepare(`${selectJobSql} WHERE j.id = ?`).bind(id).first();
    return row === null ? null : toJob(row);
  }

  private async findByInteractionId(interactionId: string): Promise<AudioJob | null> {
    const row = await this.db.prepare(`${selectJobSql} WHERE j.interaction_id = ?`).bind(interactionId).first();
    return row === null ? null : toJob(row);
  }

  async updateStatus(id: string, status: JobStatus, errorMessage: string | null = null): Promise<void> {
    const now = new Date().toISOString();
    const startedAt = status === "transcribing" ? now : null;
    const completedAt = ["completed", "partial", "failed"].includes(status) ? now : null;
    await this.db
      .prepare(`UPDATE audio_jobs SET status = ?, error_message = ?, started_at = COALESCE(started_at, ?), completed_at = COALESCE(?, completed_at) WHERE id = ?`)
      .bind(status, errorMessage, startedAt, completedAt, id)
      .run();
  }

  async clearEphemeral(jobId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM interaction_callback_secrets WHERE job_id = ?").bind(jobId),
      this.db.prepare("DELETE FROM ephemeral_attachment_references WHERE job_id = ?").bind(jobId),
    ]);
  }

  async removeAfterEnqueueFailure(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM audio_jobs WHERE id = ?").bind(id).run();
  }
}
