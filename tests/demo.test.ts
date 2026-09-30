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
    const discordContents: string[] = [];
    const discordFilenames: string[] = [];
    let geminiRequests = 0;
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
    const geminiAnalysisOutput = {
      isTransitAnnouncement: true,
      mentions: [{ text: "テスト駅", start: 2, end: 6, role: "stop", sequenceId: 1 }],
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
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === demoCommand.attachment.url) {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-length": "3", "content-type": "audio/ogg" },
        });
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        geminiRequests += 1;
        if (geminiRequests === 1) return new Response("temporary Gemini failure", { status: 503 });
        const output = geminiRequests === 2
          ? geminiAnalysisOutput
          : { normalizedTranscription: "次はテスト駅です", entities: [] };
        return Response.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
        });
      }
      if (url.includes("/webhooks/")) {
        if (typeof init?.body === "string") {
          const payload = JSON.parse(init.body) as { content?: string };
          if (payload.content !== undefined) discordContents.push(payload.content);
        } else if (init?.body instanceof FormData) {
          const payload = JSON.parse(String(init.body.get("payload_json"))) as { content?: string };
          if (payload.content !== undefined) discordContents.push(payload.content);
          const file = init.body.get("files[0]");
          if (file instanceof File) discordFilenames.push(file.name);
        }
        return new Response(null, { status: 204 });
      }
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
    expect(geminiRequests).toBe(3);
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.every((statement) => !/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/iu.test(statement)))
      .toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/webhooks/"))).toBe(true);
    expect(discordContents).toContain("🔧 音声ファイルを取得しています…");
    expect(discordContents).toContain("🔧 音声をWhisperへ送信し、文字起こししています…");
    expect(discordContents).toContain("🔧 Gemini #1で放送構造と明示metadataを解析しています…");
    expect(discordContents.some((content) =>
      content.includes("同じ文字起こしのままこの段階だけ再試行します（2/3）"))).toBe(true);
    expect(discordContents).toContain("🔧 Gemini #1が完了しました（交通案内判定: true、駅mention: 1件）。");
    expect(discordContents).toContain("🔧 Gemini #2で構造とsequence候補に制約された文字起こしを生成しています…");
    expect(discordContents.some((content) => content.startsWith("解析完了\n"))).toBe(true);
    expect(discordFilenames).toContain("platform-ai-agent-demo-debug.md");
    const resultCall = fetcher.mock.calls.find(([, init]) => {
      if (!(init?.body instanceof FormData)) return false;
      const payload = JSON.parse(String(init.body.get("payload_json"))) as { content?: string };
      return payload.content?.startsWith("解析完了\n") ?? false;
    });
    expect(String(resultCall?.[0])).toContain("/messages/@original");
    expect((resultCall?.[1]?.body as FormData).get("files[0]")).toBeInstanceOf(File);
    const diagnostics = discordContents.filter((content) => content.startsWith("**")).join("\n");
    expect(discordContents.filter((content) => content.startsWith("**"))).toHaveLength(5);
    expect(diagnostics).toContain("Whisper");
    expect(diagnostics).toContain("次はテスト駅です");
    expect(diagnostics).toContain("sequence別の駅・経路探索");
    expect(diagnostics).toContain("[REDACTED]");
    expect(diagnostics).toContain("Gemini #1 構造解析");
    expect(diagnostics).toContain("Gemini #2 raw response");
    expect(diagnostics).toContain("最終判定");
    expect(discordContents.filter((content) => content.startsWith("**"))
      .every((content) => content.length <= 2_000 && content.includes("```"))).toBe(true);
  });
});
