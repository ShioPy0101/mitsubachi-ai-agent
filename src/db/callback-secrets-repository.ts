import { z } from "zod";

const CallbackSchema = z.object({ token: z.string(), expires_at: z.string() });

export class CallbackSecretsRepository {
  constructor(private readonly db: D1Database) {}

  async get(jobId: string): Promise<{ token: string; expiresAt: string } | null> {
    const row = await this.db
      .prepare("SELECT token, expires_at FROM interaction_callback_secrets WHERE job_id = ?")
      .bind(jobId)
      .first();
    if (row === null) return null;
    const parsed = CallbackSchema.parse(row);
    return { token: parsed.token, expiresAt: parsed.expires_at };
  }

  async deleteExpired(now: string): Promise<void> {
    await this.db.prepare("DELETE FROM interaction_callback_secrets WHERE expires_at <= ?").bind(now).run();
    await this.db
      .prepare("DELETE FROM ephemeral_attachment_references WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .bind(now)
      .run();
  }
}
