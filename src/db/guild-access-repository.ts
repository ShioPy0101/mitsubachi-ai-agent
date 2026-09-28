import { z } from "zod";

const GuildAccessRowSchema = z.object({ enabled: z.union([z.literal(0), z.literal(1)]) });

export class GuildAccessRepository {
  constructor(private readonly db: D1Database) {}

  async isEnabled(guildId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT enabled FROM guild_access WHERE guild_id = ?")
      .bind(guildId)
      .first();
    return row !== null && GuildAccessRowSchema.parse(row).enabled === 1;
  }

  async setEnabled(guildId: string, enabled: boolean, userId: string, now: string): Promise<void> {
    await this.db.prepare(`
      INSERT INTO guild_access (guild_id, enabled, updated_by_user_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        enabled = excluded.enabled,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_at = excluded.updated_at
    `).bind(guildId, enabled ? 1 : 0, userId, now).run();
  }
}
