import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { JobsRepository } from "../src/db/jobs-repository";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const schema = [
  `CREATE TABLE IF NOT EXISTS audio_jobs (
    id TEXT PRIMARY KEY, guild_id TEXT, channel_id TEXT, user_id TEXT,
    interaction_id TEXT NOT NULL UNIQUE, attachment_id TEXT NOT NULL,
    original_filename TEXT NOT NULL, content_type TEXT, size_bytes INTEGER NOT NULL,
    duration_secs REAL, status TEXT NOT NULL, error_message TEXT,
    transcription_text TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, processing_started_at TEXT, deadline_at TEXT, stage TEXT, stage_started_at TEXT, failure_code TEXT, pipeline_checkpoint TEXT, presentation_mode TEXT DEFAULT 'public'
  )`,
  `CREATE TABLE IF NOT EXISTS ephemeral_attachment_references (
    job_id TEXT PRIMARY KEY, attachment_id TEXT NOT NULL, url TEXT NOT NULL,
    expires_at TEXT, created_at TEXT NOT NULL
  )`,
];

async function insertJob(
  id: string,
  status: string,
  createdAt: string,
  startedAt: string | null,
): Promise<void> {
  await env.DB.prepare(
    `
    INSERT INTO audio_jobs (
      id, interaction_id, attachment_id, original_filename, size_bytes,
      status, created_at, started_at, deadline_at
    ) VALUES (?, ?, ?, 'audio.mp3', 100, ?, ?, ?, ?)
  `,
  )
    .bind(
      id,
      `interaction-${id}`,
      `attachment-${id}`,
      status,
      createdAt,
      startedAt,
      startedAt ?? createdAt,
    )
    .run();
}

describe("D1 audio job timeout handling", () => {
  beforeEach(async () => {
    for (const statement of schema)
      await env.DB.exec(statement.replaceAll("\n", " "));
    await env.DB.exec(
      "DELETE FROM ephemeral_attachment_references; DELETE FROM audio_jobs;",
    );
  });

  it("counts only waiting jobs and uses insertion order for equal timestamps", async () => {
    const now = "2026-09-30T07:00:00.000Z";
    await insertJob("completed", "completed", "2026-09-30T06:00:00.000Z", null);
    await insertJob("active", "transcribing", "2026-09-30T06:01:00.000Z", now);
    await insertJob("z-first", "queued", now, null);
    await insertJob("a-second", "queued", now, null);
    await insertJob("later", "queued", "2026-09-30T07:01:00.000Z", null);
    const jobs = new JobsRepository(env.DB);
    expect(await jobs.queuePosition("z-first")).toBe(1);
    expect(await jobs.queuePosition("a-second")).toBe(2);
    expect(await jobs.queuePosition("later")).toBe(3);
    expect(await jobs.queuePosition("active")).toBeNull();
    expect(await jobs.queuePosition("missing")).toBeNull();
    await jobs.updateStatus("z-first", "transcribing");
    expect(await jobs.queuePosition("a-second")).toBe(1);
    await jobs.updateStatus("z-first", "queued", "transient_processing_error");
    expect(await jobs.queuePosition("a-second")).toBe(2);
  });

  it("does not stop a fourteen-minute transcription at twelve minutes", async () => {
    await insertJob(
      "long-whisper",
      "transcribing",
      "2026-09-30T07:00:00.000Z",
      "2026-09-30T07:00:00.000Z",
    );
    await env.DB.prepare(
      "UPDATE audio_jobs SET processing_started_at = ?, deadline_at = ? WHERE id = ?",
    )
      .bind(
        "2026-09-30T07:00:00.000Z",
        "2026-09-30T07:20:00.000Z",
        "long-whisper",
      )
      .run();
    const repository = new JobsRepository(env.DB);
    expect(
      await repository.findStaleActive("2026-09-30T07:12:00.000Z"),
    ).toEqual([]);
    expect(
      await repository.failIfStaleActive(
        "long-whisper",
        "2026-09-30T07:19:59.000Z",
        "job_deadline_exceeded",
        "2026-09-30T07:19:59.000Z",
      ),
    ).toBe(false);
    expect(
      await repository.failIfStaleActive(
        "long-whisper",
        "2026-09-30T07:20:00.000Z",
        "job_deadline_exceeded",
        "2026-09-30T07:20:00.000Z",
      ),
    ).toBe(true);
  });

  it("rechecks an extended deadline atomically after the stale SELECT", async () => {
    await insertJob(
      "renewed",
      "transcribing",
      "2026-09-30T07:00:00.000Z",
      "2026-09-30T07:00:00.000Z",
    );
    const repository = new JobsRepository(env.DB);
    expect(
      await repository.findStaleActive("2026-09-30T07:21:00.000Z"),
    ).toHaveLength(1);
    await env.DB.prepare("UPDATE audio_jobs SET deadline_at = ? WHERE id = ?")
      .bind("2026-09-30T07:30:00.000Z", "renewed")
      .run();
    expect(
      await repository.failIfStaleActive(
        "renewed",
        "2026-09-30T07:21:00.000Z",
        "job_deadline_exceeded",
        "2026-09-30T07:21:00.000Z",
      ),
    ).toBe(false);
  });

  it("finds only active jobs whose effective start is older than the cutoff", async () => {
    await insertJob(
      "stale-running",
      "transcribing",
      "2026-09-30T07:00:00.000Z",
      "2026-09-30T07:10:00.000Z",
    );
    await insertJob(
      "fresh-running",
      "transcribing",
      "2026-09-30T07:00:00.000Z",
      "2026-09-30T07:50:00.000Z",
    );
    await insertJob(
      "fresh-space-format",
      "transcribing",
      "2026-09-30 07:00:00",
      "2026-09-30 07:50:00",
    );
    await insertJob(
      "stale-complete",
      "completed",
      "2026-09-30T07:00:00.000Z",
      "2026-09-30T07:10:00.000Z",
    );

    const stale = await new JobsRepository(env.DB).findStaleActive(
      "2026-09-30T07:45:00.000Z",
    );

    expect(stale.map((job) => job.id)).toEqual(["stale-running"]);
  });

  it("stops an active job once and keeps the terminal state final", async () => {
    const repository = new JobsRepository(env.DB);
    await insertJob(
      "stale",
      "transcribing",
      "2026-09-30T07:00:00.000Z",
      "2026-09-30T07:10:00.000Z",
    );

    await expect(
      repository.failIfStaleActive(
        "stale",
        "2026-09-30T07:45:00.000Z",
        "processing_timeout",
        "2026-09-30T08:00:00.000Z",
      ),
    ).resolves.toBe(true);
    await expect(repository.isActive("stale")).resolves.toBe(false);
    await expect(
      repository.failIfStaleActive(
        "stale",
        "2026-09-30T07:45:00.000Z",
        "processing_timeout",
        "2026-09-30T08:01:00.000Z",
      ),
    ).resolves.toBe(false);
    await repository.updateStatus("stale", "completed");

    await expect(repository.findById("stale")).resolves.toMatchObject({
      status: "failed",
      errorMessage: "processing_timeout",
      completedAt: "2026-09-30T08:00:00.000Z",
    });
  });

  it("rechecks the cutoff atomically before changing an active job", async () => {
    const repository = new JobsRepository(env.DB);
    await insertJob(
      "fresh",
      "metadata_extracting",
      "2026-09-30T07:49:00.000Z",
      "2026-09-30T07:50:00.000Z",
    );

    await expect(
      repository.failIfStaleActive(
        "fresh",
        "2026-09-30T07:45:00.000Z",
        "processing_timeout",
        "2026-09-30T08:00:00.000Z",
      ),
    ).resolves.toBe(false);
    await expect(repository.findById("fresh")).resolves.toMatchObject({
      status: "metadata_extracting",
      errorMessage: null,
      completedAt: null,
    });
  });
});
