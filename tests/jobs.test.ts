import { describe, expect, it, vi } from "vitest";
import { DemoJobProducer, JobProducer, type JobQueue, type JobStore } from "../src/jobs/producer";
import { staleAudioJobCutoff, staleAudioJobTimeoutMs } from "../src/jobs/staleness";
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
  it("uses a 15 minute cutoff", () => {
    expect(staleAudioJobTimeoutMs).toBe(15 * 60 * 1000);
    expect(staleAudioJobCutoff(new Date("2026-09-30T08:00:00.000Z")))
      .toBe("2026-09-30T07:45:00.000Z");
  });
});
