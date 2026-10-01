import { ClipsRepository } from "../src/db/clips-repository";
import { env } from "cloudflare:test";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { consumeAudioJobs } from "../src/jobs/consumer";
import { JobProducer } from "../src/jobs/producer";
import { JobsRepository } from "../src/db/jobs-repository";
import type { AudioJobMessage } from "../src/jobs/types";
import m1 from "../migrations/0001_initial.sql?raw";
import m2 from "../migrations/0002_stations.sql?raw";
import m3 from "../migrations/0003_add_transcription_checkpoint.sql?raw";
import m4 from "../migrations/0004_add_audio_job_user_id.sql?raw";
import m5 from "../migrations/0005_create_guild_access.sql?raw";
import m6 from "../migrations/0006_station_line_paths.sql?raw";
import m7 from "../migrations/0007_job_monitor_messages.sql?raw";
import m8 from "../migrations/0008_job_monitor_observations.sql?raw";
import m9 from "../migrations/0009_pipeline_deadlines.sql?raw";
import m10 from "../migrations/0010_static_railway.sql?raw";
const migrate = async (sql: string) => {
  for (const statement of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await env.DB.prepare(statement).run();
};
beforeEach(async () => {
  for (const sql of [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10])
    await migrate(sql);
});
afterEach(() => vi.unstubAllGlobals());
const raw = "次は篠原、安雪、守山です。The next stop is Yasu.";
const normalized = "次は篠原、野洲、守山です。The next stop is Yasu.";
const metadata = {
  station: null,
  line: "琵琶湖線",
  trainType: null,
  trainName: null,
  trainNumber: null,
  destination: null,
  departureTime: null,
  arrivalTime: null,
  platform: null,
  nextStation: "安雪",
  category: "general_information" as const,
  summary: "停車駅：篠原・安雪・守山",
};
const mentions = ["篠原", "安雪", "守山"].map((text) => ({
  text,
  start: raw.indexOf(text),
  end: raw.indexOf(text) + text.length,
  role: "stop",
  sequenceId: 1,
  phoneticHint: text === "安雪" ? "やす" : null,
}));
describe("fresh local D1 and queue pipeline with fake providers", () => {
  for (const scenario of ["public", "demo", "demo-retry"] as const)
    it(`runs ${scenario} without railway D1 tables, preserves raw and delivers`, async () => {
      const presentationMode = scenario === "public" ? "public" : "demo";
      const tables = (
        await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table'",
        ).all()
      ).results.map((row) => row.name);
      expect(tables).not.toContain("stations");
      expect(tables).not.toContain("station_line_positions");
      expect(tables).not.toContain("route_segment_connections");
      const messages: AudioJobMessage[] = [];
      const { job } = await new JobProducer(new JobsRepository(env.DB), {
        send: async (message) => {
          messages.push(message);
        },
      }).createAndEnqueue(
        {
          presentationMode,
          source: {
            type: "interaction",
            guildId: "g",
            channelId: null,
            userId: "u",
            interactionId: presentationMode,
            attachmentId: "a",
            temporaryReference: {
              url: "https://cdn.discordapp.com/test.ogg",
              expiresAt: null,
            },
          },
          interactionCallback: {
            token: "token",
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          },
          originalFilename: "test.ogg",
          contentType: "audio/ogg",
          sizeBytes: 3,
          durationSecs: 3,
        },
        new Date().toISOString(),
      );
      let geminiCalls = 0;
      const delivered: string[] = [];
      const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("cdn.discordapp.com"))
          return new Response(new Uint8Array([1, 2, 3]));
        if (url.includes("generativelanguage.googleapis.com")) {
          geminiCalls++;
          if (scenario === "demo-retry" && geminiCalls >= 2 && geminiCalls <= 4)
            return new Response("temporary failure", { status: 503 });
          const output =
            geminiCalls === 1
              ? { isTransitAnnouncement: true, mentions, ...metadata }
              : {
                  normalizedTranscription: normalized,
                  metadata: {
                    ...metadata,
                    nextStation: "野洲",
                    summary: "停車駅：篠原・野洲・守山",
                  },
                  normalizedEvents: [
                    {
                      sourceEventId: "missing-debug-id",
                      language: "ja",
                      text: "し\n。\n3. Pl\ne\nthrough.",
                    },
                  ],
                  entities: [],
                };
          return Response.json({
            candidates: [
              { content: { parts: [{ text: JSON.stringify(output) }] } },
            ],
          });
        }
        if (url.includes("webhooks")) {
          const payload =
            init?.body instanceof FormData
              ? JSON.parse(String(init.body.get("payload_json")))
              : JSON.parse(String(init?.body));
          if (init?.method === "POST") expect(payload.flags).toBe(64);
          delivered.push(payload.content ?? "");
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected external call: ${url}`);
      });
      vi.stubGlobal("fetch", fetcher);
      const ai = {
        run: vi.fn().mockResolvedValue({
          text: raw,
          segments: [
            { start: 0, end: 3, text: "次は篠原、安雪、守山です。" },
            { start: 3, end: 6, text: "The next stop is Yasu." },
          ],
          transcription_info: { language: "ja" },
        }),
      };
      const ack = vi.fn(),
        retry = vi.fn();
      const consume = async (attempts: number) =>
        consumeAudioJobs(
          {
            queue: "local",
            messages: [
              {
                id: "q",
                body: messages[0]!,
                timestamp: new Date(),
                attempts,
                ack,
                retry,
              },
            ],
            ackAll: vi.fn(),
            retryAll: vi.fn(),
          } as unknown as MessageBatch<AudioJobMessage>,
          {
            DB: env.DB,
            AI: ai,
            DISCORD_BOT_TOKEN: "token",
            DISCORD_APPLICATION_ID: "app",
            GEMINI_API_KEY: "key",
            GEMINI_MODEL: "fake",
            MAX_AUDIO_BYTES: "1000",
            ADMIN_JOBS_CHANNEL_ID: "",
          } as unknown as Env,
        );
      await consume(1);
      if (scenario === "demo-retry") {
        expect(retry).toHaveBeenCalledOnce();
        expect(ack).not.toHaveBeenCalled();
        await consume(2);
      }
      expect(ack).toHaveBeenCalledOnce();
      if (scenario !== "demo-retry") expect(retry).not.toHaveBeenCalled();
      expect(ai.run).toHaveBeenCalledOnce();
      expect(geminiCalls).toBe(scenario === "demo-retry" ? 5 : 2);
      const persisted = await new JobsRepository(env.DB).findById(job.id);
      expect(persisted?.status).toBe("completed");
      expect(persisted?.transcriptionText).toBe(raw);
      const checkpoint = await env.DB.prepare(
        "SELECT pipeline_checkpoint FROM audio_jobs WHERE id=?",
      )
        .bind(job.id)
        .first<{ pipeline_checkpoint: string }>();
      const stored = JSON.parse(checkpoint!.pipeline_checkpoint);
      expect(stored.speech.value.segments).toHaveLength(2);
      expect(
        stored.analysis.value.semantic.sourceSegments.map(
          (s: { id: string }) => s.id,
        ),
      ).toEqual(["speech-segment:0", "speech-segment:1"]);
      const clip = await env.DB.prepare(
        "SELECT raw_transcription,normalized_transcription,next_station,summary,generated_filename FROM railway_audio_clips WHERE job_id=?",
      )
        .bind(job.id)
        .first();
      expect(clip).toMatchObject({
        raw_transcription: raw,
        normalized_transcription: normalized,
        next_station: "野洲",
        summary: "停車駅：篠原・野洲・守山",
      });
      expect(String(clip?.generated_filename)).toContain("次は野洲");
      expect(String(clip?.generated_filename)).not.toContain("安雪");
      expect(
        delivered.some((content) =>
          content.includes("停車駅：篠原・野洲・守山"),
        ),
      ).toBe(true);
      expect(delivered.some((content) => content.includes(normalized))).toBe(
        true,
      );
      // Public prose and demo prose both use the provider document. Demo may
      // separately attach the flawed event array as diagnostics.
      expect(
        delivered.some((content) =>
          content.includes("し\n。\n3. Pl\ne\nthrough."),
        ),
      ).toBe(false);
      await new JobsRepository(env.DB).saveTranscription(
        job.id,
        "attempted raw overwrite",
      );
      await new ClipsRepository(env.DB).save({
        jobId: job.id,
        clipIndex: 1,
        rawTranscription: "attempted raw overwrite",
        normalizedTranscription: "derived result",
        metadata,
        resolution: {
          stationName: null,
          candidateStationId: null,
          confidence: 0,
          source: "unresolved",
        },
        generatedFilename: "test.ogg",
        createdAt: new Date().toISOString(),
      });
      expect(
        (await new JobsRepository(env.DB).findById(job.id))?.transcriptionText,
      ).toBe(raw);
      expect(
        await env.DB.prepare(
          "SELECT raw_transcription FROM railway_audio_clips WHERE job_id=?",
        )
          .bind(job.id)
          .first(),
      ).toEqual({ raw_transcription: raw });
      expect(delivered.some((text) => text.startsWith("解析完了"))).toBe(true);
      if (presentationMode === "public")
        expect(delivered.join("\n")).not.toMatch(
          /Gemini|Whisper|Workers AI|D1|route graph|normalization guard|prompt injection/i,
        );
      else expect(delivered.join("\n")).toContain("Gemini #2");
      expect(
        (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
    });
});
