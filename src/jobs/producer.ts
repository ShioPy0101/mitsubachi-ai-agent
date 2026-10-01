import type { AudioJob, AudioJobMessage, NewAudioJob } from "./types";

export interface JobStore {
  create(
    input: NewAudioJob,
    now: string,
  ): Promise<{ job: AudioJob; created: boolean }>;
  removeAfterEnqueueFailure(id: string): Promise<void>;
}

export interface JobQueue {
  send(
    message: AudioJobMessage,
    options: { contentType: "json" },
  ): Promise<unknown>;
}

export class JobProducer {
  constructor(
    private readonly jobs: JobStore,
    private readonly queue: JobQueue,
  ) {}

  async createAndEnqueue(
    input: NewAudioJob,
    now: string,
  ): Promise<{ job: AudioJob; created: boolean }> {
    const result = await this.jobs.create(input, now);
    if (!result.created) return result;
    try {
      await this.queue.send({ jobId: result.job.id }, { contentType: "json" });
    } catch (error) {
      await this.jobs.removeAfterEnqueueFailure(result.job.id);
      throw error;
    }
    return result;
  }
}
