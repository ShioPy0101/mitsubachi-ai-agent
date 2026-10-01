export type CheckpointStage = "analysis" | "correction";
export interface PipelineCheckpointStore {
  read<T>(stage: CheckpointStage, source: string): Promise<T | null>;
  write<T>(stage: CheckpointStage, source: string, value: T): Promise<void>;
}
const checkpointVersion = 2;
async function hash(source: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
// In-memory test adapter retains intermediate state only inside this execution.
export class MemoryPipelineCheckpoints implements PipelineCheckpointStore {
  private values = new Map<string, unknown>();
  async read<T>(stage: CheckpointStage, source: string): Promise<T | null> {
    return (
      (this.values.get(`${stage}:${await hash(source)}`) as T | undefined) ??
      null
    );
  }
  async write<T>(
    stage: CheckpointStage,
    source: string,
    value: T,
  ): Promise<void> {
    this.values.set(`${stage}:${await hash(source)}`, value);
  }
}
export class D1PipelineCheckpoints implements PipelineCheckpointStore {
  private snapshot: Record<
    string,
    { version: number; hash: string; value: unknown }
  > | null = null;
  constructor(
    private readonly db: D1Database,
    private readonly jobId: string,
  ) {}
  private async load() {
    if (!this.snapshot) {
      const row = await this.db
        .prepare("SELECT pipeline_checkpoint FROM audio_jobs WHERE id = ?")
        .bind(this.jobId)
        .first<{ pipeline_checkpoint: string | null }>();
      try {
        this.snapshot = JSON.parse(row?.pipeline_checkpoint ?? "{}");
      } catch {
        this.snapshot = {};
      }
    }
    return this.snapshot!;
  }
  async read<T>(stage: CheckpointStage, source: string): Promise<T | null> {
    const entry = (await this.load())[stage];
    return entry?.version === checkpointVersion &&
      entry.hash === (await hash(source))
      ? (entry.value as T)
      : null;
  }
  async write<T>(
    stage: CheckpointStage,
    source: string,
    value: T,
  ): Promise<void> {
    const snapshot = await this.load();
    snapshot[stage] = {
      version: checkpointVersion,
      hash: await hash(source),
      value,
    };
    await this.db
      .prepare(
        "UPDATE audio_jobs SET pipeline_checkpoint = ? WHERE id = ? AND status NOT IN ('completed','partial','failed')",
      )
      .bind(JSON.stringify(snapshot), this.jobId)
      .run();
  }
}
