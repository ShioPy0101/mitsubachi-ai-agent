import { describe, expect, it, vi } from "vitest";
import { DemoJobProducer, JobProducer, type JobQueue, type JobStore } from "../src/jobs/producer";
import {
  audioJobElapsedMs,
  isStaleAudioJob,
  staleAudioJobCutoff,
  staleAudioJobTimeoutMs,
} from "../src/jobs/staleness";
import { whisperProcessingTimeoutMs } from "../src/jobs/processing-timeout";
import { runStage, shouldRetryAudioJob } from "../src/jobs/consumer";
import { WhisperAudioDecodeError } from "../src/transcription/workers-ai";
import type { AudioJob, NewAudioJob } from "../src/jobs/types";

const input: NewAudioJob = {
  source: {
    type: "interaction", guildId: "guild", channelId: "channel", userId: "user", interactionId: "interaction",
    attachmentId: "attachment", temporaryReference: { url: "https://example.com/audio.mp3", expiresAt: null },
  },
  interactionCallback: { token: "secret", expiresAt: "2026-01-01T00:15:00.000Z" },
  originalFilename: "audio.mp3", contentType: "audio/mpeg", sizeBytes: 100, durationSecs: null,
};

const job: AudioJob = {
  id: "00000000-0000-4000-8000-000000000000",
  source: input.source,
  originalFilename: input.originalFilename,
  contentType: input.contentType,
  sizeBytes: input.sizeBytes,
  durationSecs: input.durationSecs,
  status: "queued",
  errorMessage: null,
  transcriptionText: null,
  transcriptionSegments: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
};

function store(created: boolean): JobStore {
  return {
    create: vi.fn().mockResolvedValue({ job, created }),
    removeAfterEnqueueFailure: vi.fn().mockResolvedValue(undefined),
  };
}

describe("job producer", () => {
  it("queues only the job ID", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const queue: JobQueue = { send };
    await new JobProducer(store(true), queue).createAndEnqueue(input, job.createdAt);
    expect(send).toHaveBeenCalledWith({ jobId: job.id }, { contentType: "json" });
  });

  it("does not queue an interaction duplicate", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await new JobProducer(store(false), { send }).createAndEnqueue(input, job.createdAt);
    expect(send).not.toHaveBeenCalled();
  });

  it("queues demo input without creating a persistent job", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const message = {
      kind: "demo" as const,
      interactionId: "interaction",
      interactionToken: "token",
      userId: "owner",
      attachment: {
        id: "attachment", filename: "audio.ogg", size: 100, url: "https://example.com/audio.ogg",
        contentType: "audio/ogg", durationSecs: null,
      },
    };
    await new DemoJobProducer({ send }).enqueue(message);
    expect(send).toHaveBeenCalledWith(message, { contentType: "json" });
  });
});

describe("stale audio jobs", () => {
  it("uses a 12 minute cutoff so Discord can still receive the failure response", () => {
    expect(staleAudioJobTimeoutMs).toBe(12 * 60 * 1000);
    expect(staleAudioJobCutoff(new Date("2026-09-30T08:00:00.000Z")))
      .toBe("2026-09-30T07:48:00.000Z");
  });

  it("does not classify a 160 second job as stale", () => {
    const now = new Date("2026-10-01T08:21:37.609Z");
    expect(audioJobElapsedMs("2026-10-01T08:18:56.054Z", "2026-10-01T08:18:57.609Z", now))
      .toBe(160_000);
    expect(isStaleAudioJob("2026-10-01T08:18:56.054Z", "2026-10-01T08:18:57.609Z", now))
      .toBe(false);
  });

  it("requires a valid effective start timestamp", () => {
    expect(isStaleAudioJob("invalid", null, new Date("2026-10-01T08:30:00.000Z"))).toBe(false);
  });
});

describe("audio job processing deadline", () => {
  it("keeps the Whisper safety deadline outside normal processing time", () => {
    expect(whisperProcessingTimeoutMs(125.4)).toBe(600_000);
    expect(whisperProcessingTimeoutMs(5)).toBe(600_000);
    expect(whisperProcessingTimeoutMs(240)).toBe(720_000);
    expect(whisperProcessingTimeoutMs(600)).toBe(840_000);
    expect(whisperProcessingTimeoutMs(null)).toBe(10 * 60 * 1000);
  });
});

describe("audio job retry boundary", () => {
  it("retries a transient processing stage before the queue limit", async () => {
    const error = new Error("temporary D1 failure");
    await expect(runStage("job-id", "station_candidates_sequence_1", async () => {
      throw error;
    })).rejects.toBe(error);

    expect(shouldRetryAudioJob(error, 1)).toBe(true);
    expect(shouldRetryAudioJob(error, 5)).toBe(false);
  });

  it.each(["transcription_checkpoint", "result_notification", "completion_status"])(
    "does not restart the pipeline after %s fails",
    async (stage) => {
      const error = new Error(`${stage} failed`);
      await expect(runStage("job-id", stage, async () => {
        throw error;
      })).rejects.toBe(error);

      expect(shouldRetryAudioJob(error, 1)).toBe(false);
    },
  );

  it("does not retry an explicit MP3 decode failure", () => {
    expect(shouldRetryAudioJob(
      new WhisperAudioDecodeError(new Error("original"), new Error("rebuilt")),
      1,
    )).toBe(false);
  });
});
