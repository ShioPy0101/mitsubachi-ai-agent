import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobMonitorRepository } from "../src/db/job-monitor-repository";
import type { DiscordRestClient } from "../src/discord/rest-client";
import { runStage } from "../src/jobs/consumer";
import { JobCancellationRequestedError, JobMonitor } from "../src/jobs/job-monitor";
import { AudioJobProcessingTimeoutError } from "../src/jobs/processing-timeout";
import type { AudioJob } from "../src/jobs/types";
import { handleAdminJobStopInteraction } from "../src/routes/interactions";

declare module "cloudflare:test" {
  interface ProvidedEnv { DB: D1Database }
}

const monitorSchema = `CREATE TABLE IF NOT EXISTS job_monitor_messages (
  job_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, message_id TEXT,
  current_stage TEXT NOT NULL, stage_detail TEXT, state TEXT NOT NULL, queue_attempt INTEGER NOT NULL,
  user_id TEXT, filename TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  started_at TEXT NOT NULL, stage_started_at TEXT NOT NULL, stage_timeout_at TEXT, updated_at TEXT NOT NULL,
  cancellation_requested_at TEXT, completed_at TEXT, error_message TEXT
  , observations TEXT NOT NULL DEFAULT ''
)`;

function job(id = "job-id"): AudioJob {
  return {
    id,
    source: {
      type: "interaction", guildId: "guild", channelId: "source-channel", userId: "user",
      interactionId: "interaction", attachmentId: "attachment",
      temporaryReference: { url: "https://example.com/audio.mp3", expiresAt: null },
    },
    originalFilename: "sample.mp3", contentType: "audio/mpeg", sizeBytes: 13_000_000,
    durationSecs: null, status: "queued", errorMessage: null, transcriptionText: null,
    transcriptionSegments: null,
    createdAt: "2026-10-01T00:00:00.000Z", startedAt: null, completedAt: null,
  };
}

function discordMock() {
  return {
    createChannelMessage: vi.fn().mockResolvedValue({ ok: true, messageId: "monitor-message" }),
    editChannelMessage: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe("audio job monitor", () => {
  beforeEach(async () => {
    await env.DB.exec(monitorSchema.replaceAll("\n", " "));
    await env.DB.exec("DELETE FROM job_monitor_messages");
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates one message per job and edits it on retry and stage changes", async () => {
    const repository = new JobMonitorRepository(env.DB);
    const discord = discordMock();
    const monitor = new JobMonitor("admin-jobs", repository, discord as unknown as DiscordRestClient);

    await monitor.start(job(), 1);
    await monitor.stageStarted("job-id", "gemini_analysis", 90_000);
    await monitor.stageProgress("job-id", "2チャンク完了・90.0 / 180.0秒");
    await monitor.observation("job-id", "駅候補探索: phase 80ms・D1 3");
    await monitor.start(job(), 2);

    expect(discord.createChannelMessage).toHaveBeenCalledOnce();
    expect(discord.editChannelMessage).toHaveBeenCalledTimes(4);
    await expect(repository.find("job-id")).resolves.toMatchObject({
      messageId: "monitor-message", currentStage: "gemini_analysis", queueAttempt: 2,
    });
    const lastContent = discord.editChannelMessage.mock.calls.at(-1)?.[2] as string;
    expect(lastContent).toContain("Queue attempt:\n2");
    expect(lastContent).toContain("Gemini #1 放送構造解析");
    expect(lastContent).toContain("フェーズ開始から:");
    expect(lastContent).toContain("現在フェーズのタイムアウト:\n90.0秒");
    expect(lastContent).toContain("2チャンク完了・90.0 / 180.0秒");
    expect(lastContent).toContain("観測:");
    expect(lastContent).toContain("駅候補探索: phase 80ms・D1 3");
  });

  it("persists stop requests and refuses to start the next stage", async () => {
    const repository = new JobMonitorRepository(env.DB);
    const discord = discordMock();
    const monitor = new JobMonitor("admin-jobs", repository, discord as unknown as DiscordRestClient);
    await monitor.start(job(), 1);
    await monitor.requestCancellation("job-id");
    const operation = vi.fn();

    await expect(runStage("job-id", "gemini_analysis", operation, monitor))
      .rejects.toBeInstanceOf(JobCancellationRequestedError);
    expect(operation).not.toHaveBeenCalled();
    await expect(repository.find("job-id")).resolves.toMatchObject({
      state: "cancel_requested",
      cancellationRequestedAt: expect.any(String),
    });
  });

  it("stops after an in-flight stage returns when cancellation was requested during it", async () => {
    const repository = new JobMonitorRepository(env.DB);
    const monitor = new JobMonitor("admin-jobs", repository, discordMock() as unknown as DiscordRestClient);
    await monitor.start(job(), 1);

    await expect(runStage("job-id", "whisper_transcription", async () => {
      await repository.requestCancellation("job-id", new Date().toISOString());
      return "transcribed";
    }, monitor)).rejects.toMatchObject({
      name: "JobCancellationRequestedError", stage: "whisper_transcription",
    });
  });

  it("refreshes elapsed phase time while a stage is still running", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => { finish = resolve; });
    const monitor = {
      enabled: true,
      assertNotCancelled: vi.fn().mockResolvedValue(undefined),
      stageStarted: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
    } as unknown as JobMonitor;

    const running = runStage("job-id", "whisper_transcription", () => operation, monitor);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(monitor.refresh).toHaveBeenCalledWith("job-id");
    finish();
    await running;
  });

  it("aborts an in-flight provider operation at the stage deadline", async () => {
    vi.useFakeTimers();
    const receivedSignals: AbortSignal[] = [];
    const running = runStage("job-id", "whisper_transcription", async (signal) => {
      receivedSignals.push(signal);
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }, undefined, 5_000);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(running).rejects.toEqual(new AudioJobProcessingTimeoutError(5_000));
    expect(receivedSignals[0]?.aborted).toBe(true);
  });

  it("disables the stop button and displays terminal details", async () => {
    const repository = new JobMonitorRepository(env.DB);
    const discord = discordMock();
    const monitor = new JobMonitor("admin-jobs", repository, discord as unknown as DiscordRestClient);
    await monitor.start(job(), 1);
    await monitor.transition("job-id", "completed", "ephemeral_cleanup");
    await monitor.transition("job-id", "failed", "gemini_normalization", new Error("bad response"));

    const completedCall = discord.editChannelMessage.mock.calls.at(-2)!;
    expect(completedCall[2]).toContain("✅ ジョブ完了");
    expect(completedCall[3][0].components[0].disabled).toBe(true);
    const failedCall = discord.editChannelMessage.mock.calls.at(-1)!;
    expect(failedCall[2]).toContain("❌ ジョブ失敗");
    expect(failedCall[2]).toContain("Error: bad response");
  });

  it("supports demo job ids in the same persistent cancellation store", async () => {
    const repository = new JobMonitorRepository(env.DB);
    const monitor = new JobMonitor("admin-jobs", repository, discordMock() as unknown as DiscordRestClient);
    await monitor.start(job("demo:123456789"), 1);
    await monitor.requestCancellation("demo:123456789");
    await expect(repository.isCancellationRequested("demo:123456789")).resolves.toBe(true);
  });

  it("rejects unprivileged or wrong-channel stop interactions", async () => {
    const base = {
      id: "interaction", application_id: "application", type: 3, token: "token",
      channel_id: "admin-jobs", member: { user: { id: "actor" }, permissions: "0" },
      data: { custom_id: "admin_job_stop:job-id" },
    };
    const testEnv = {
      DB: env.DB, ADMIN_JOBS_CHANNEL_ID: "admin-jobs",
      DISCORD_BOT_TOKEN: "token", DISCORD_APPLICATION_ID: "application",
    } as unknown as Env;

    const denied = await handleAdminJobStopInteraction(base, testEnv);
    expect(await denied?.json()).toMatchObject({ data: { content: expect.stringContaining("管理権限") } });
    const wrongChannel = await handleAdminJobStopInteraction({ ...base, channel_id: "elsewhere" }, testEnv);
    expect(await wrongChannel?.json()).toMatchObject({ data: { content: expect.stringContaining("この場所") } });
  });

  it("allows Manage Guild and immediately updates the persisted state and message", async () => {
    const repository = new JobMonitorRepository(env.DB);
    await repository.ensure({
      jobId: "job-id", channelId: "admin-jobs", queueAttempt: 1, userId: "user",
      filename: "sample.mp3", sizeBytes: 100, now: new Date().toISOString(),
    });
    await repository.setMessageId("job-id", "monitor-message", new Date().toISOString());
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const response = await handleAdminJobStopInteraction({
      id: "interaction", application_id: "application", type: 3, token: "token",
      channel_id: "admin-jobs", member: { user: { id: "actor" }, permissions: "32" },
      data: { custom_id: "admin_job_stop:job-id" },
    }, {
      DB: env.DB, ADMIN_JOBS_CHANNEL_ID: "admin-jobs",
      DISCORD_BOT_TOKEN: "token", DISCORD_APPLICATION_ID: "application",
    } as unknown as Env);

    expect(await response?.json()).toMatchObject({ data: { content: expect.stringContaining("停止を要求") } });
    await expect(repository.isCancellationRequested("job-id")).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/admin-jobs/messages/monitor-message",
      expect.objectContaining({ method: "PATCH" }),
    );
  });
});
