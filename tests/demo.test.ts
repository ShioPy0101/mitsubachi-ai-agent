import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDemoCommand } from "../src/routes/interactions";
import { consumeAudioJobs } from "../src/jobs/consumer";
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
    });

    expect(await response.json()).toEqual({ type: 5 });
    expect(send).toHaveBeenCalledWith({
      kind: "demo",
      interactionId: "interaction",
      interactionToken: "callback-token",
      userId: "owner",
      attachment: demoCommand.attachment,
    }, { contentType: "json" });

    const oversizedSend = vi.fn();
    const oversized = await handleDemoCommand({
      ...demoCommand,
      attachment: { ...demoCommand.attachment, size: 4 },
    }, {
      AUDIO_JOBS: { send: oversizedSend },
      DISCORD_CONTROL_USER_IDS: '["owner"]',
      MAX_AUDIO_BYTES: "3",
    });
    expect(await oversized.json()).toMatchObject({ type: 4 });
    expect(oversizedSend).not.toHaveBeenCalled();
  });

  it("runs the shared async analysis without issuing a D1 write", async () => {
    const sql: string[] = [];
    const db = {
      prepare(statement: string) {
        sql.push(statement);
        if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/iu.test(statement)) {
          throw new Error(`unexpected D1 write: ${statement}`);
        }
        const query = {
          bind: () => query,
          all: async () => ({ results: [] }),
          first: async () => null,
        };
        return query;
      },
    };
    const ai = {
      run: vi.fn().mockResolvedValue({
        transcription_info: { language: "ja" },
        text: "次はテスト駅です",
        segments: [],
      }),
    };
    const geminiOutput = {
      isTransitAnnouncement: true,
      normalizedTranscription: "次はテスト駅です",
      station: null,
      line: "テスト線",
      trainType: null,
      trainName: null,
      trainNumber: null,
      destination: null,
      departureTime: null,
      arrivalTime: null,
      platform: null,
      nextStation: "テスト駅",
      category: "general_information",
      summary: "次駅案内",
    };
    const fetcher = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url === demoCommand.attachment.url) {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-length": "3", "content-type": "audio/ogg" },
        });
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        return Response.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify(geminiOutput) }] } }],
        });
      }
      if (url.includes("/webhooks/")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const ack = vi.fn();
    const retry = vi.fn();
    const message = {
      id: "queue-message",
      timestamp: new Date(),
      attempts: 1,
      body: {
        kind: "demo",
        interactionId: demoCommand.interactionId,
        interactionToken: demoCommand.interactionToken,
        userId: demoCommand.userId,
        attachment: demoCommand.attachment,
      },
      ack,
      retry,
    };
    const batch = { queue: "audio", messages: [message], ackAll: vi.fn(), retryAll: vi.fn() };
    const env = {
      DB: db,
      AI: ai,
      DISCORD_BOT_TOKEN: "bot-token",
      DISCORD_APPLICATION_ID: "application",
      GEMINI_API_KEY: "gemini-key",
      GEMINI_MODEL: "gemini-model",
      MAX_AUDIO_BYTES: "26214400",
    };

    await consumeAudioJobs(
      batch as unknown as MessageBatch<AudioJobMessage>,
      env as unknown as Env,
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(ai.run).toHaveBeenCalledOnce();
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.every((statement) => !/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/iu.test(statement)))
      .toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/webhooks/"))).toBe(true);
  });
});
