import { env as localEnv } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { handleDemoCommand } from "../src/routes/interactions";
import type { AudioJobMessage } from "../src/jobs/types";

const demoCommand = {
  kind: "demo" as const,
  interactionId: "interaction",
  interactionToken: "callback-token",
  guildId: "guild",
  channelId: "channel",
  userId: "owner",
  attachment: {
    id: "attachment",
    filename: "announcement.ogg",
    size: 3,
    url: "https://cdn.discordapp.com/announcement.ogg",
    contentType: "audio/ogg",
    durationSecs: null,
  },
};

beforeEach(async () => {
  await localEnv.DB
    .exec(`CREATE TABLE IF NOT EXISTS audio_jobs (id TEXT PRIMARY KEY, guild_id TEXT, channel_id TEXT, user_id TEXT, interaction_id TEXT UNIQUE, attachment_id TEXT, original_filename TEXT, content_type TEXT, size_bytes INTEGER, duration_secs REAL, status TEXT, error_message TEXT, transcription_text TEXT, created_at TEXT, started_at TEXT, completed_at TEXT, processing_started_at TEXT, deadline_at TEXT, stage TEXT, stage_started_at TEXT, failure_code TEXT, pipeline_checkpoint TEXT, presentation_mode TEXT);
  CREATE TABLE IF NOT EXISTS ephemeral_attachment_references (job_id TEXT PRIMARY KEY, attachment_id TEXT, url TEXT, expires_at TEXT, created_at TEXT);
  CREATE TABLE IF NOT EXISTS interaction_callback_secrets (interaction_id TEXT PRIMARY KEY, job_id TEXT UNIQUE, token TEXT, expires_at TEXT, created_at TEXT);`);
});
afterEach(() => vi.unstubAllGlobals());

describe("owner-only demo", () => {
  it("rejects an unconfigured user before enqueueing any processing", async () => {
    const send = vi.fn();
    const response = await handleDemoCommand(
      { ...demoCommand, userId: "administrator-but-not-owner" },
      {
        AUDIO_JOBS: { send } as unknown as Queue<AudioJobMessage>,
        DISCORD_CONTROL_USER_IDS: '["owner"]',
        MAX_AUDIO_BYTES: "26214400",
        DB: localEnv.DB,
      },
    );

    expect(await response.json()).toEqual({
      type: 4,
      data: { content: "この操作を実行する権限がありません。", flags: 64 },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("bypasses guild allow-list lookup for a configured owner and preserves input limits", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const response = await handleDemoCommand(demoCommand, {
      AUDIO_JOBS: { send },
      DISCORD_CONTROL_USER_IDS: '["owner"]',
      MAX_AUDIO_BYTES: "3",
      DB: localEnv.DB,
    });

    expect(await response.json()).toEqual({ type: 5 });
    expect(send).toHaveBeenCalledWith(
      { jobId: expect.any(String) },
      { contentType: "json" },
    );
    const job = await localEnv.DB.prepare(
      "SELECT presentation_mode FROM audio_jobs WHERE interaction_id = ?",
    )
      .bind(demoCommand.interactionId)
      .first();
    expect(job).toEqual({ presentation_mode: "demo" });

    const oversizedSend = vi.fn();
    const oversized = await handleDemoCommand(
      {
        ...demoCommand,
        attachment: { ...demoCommand.attachment, size: 4 },
      },
      {
        AUDIO_JOBS: { send: oversizedSend },
        DISCORD_CONTROL_USER_IDS: '["owner"]',
        MAX_AUDIO_BYTES: "3",
        DB: localEnv.DB,
      },
    );
    expect(await oversized.json()).toMatchObject({ type: 4 });
    expect(oversizedSend).not.toHaveBeenCalled();
  });

  it("rejects the removed alpha command", async () => {
    const { parsePlatformCommand } =
      await import("../src/discord/interactions");
    expect(
      parsePlatformCommand({
        id: "i",
        token: "t",
        type: 2,
        data: { name: "platform-ai-agent-alpha" },
      }).ok,
    ).toBe(false);
  });
});
