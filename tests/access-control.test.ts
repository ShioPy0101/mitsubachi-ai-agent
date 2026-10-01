import { describe, expect, it, vi } from "vitest";
import { GuildAccessRepository } from "../src/db/guild-access-repository";
import { canControlGuild } from "../src/discord/access-control";

describe("guild access control", () => {
  it("allows only explicitly configured controller IDs", () => {
    expect(canControlGuild('["100","200"]', "200")).toBe(true);
    expect(canControlGuild('["100","200"]', "300")).toBe(false);
    expect(canControlGuild("invalid", "100")).toBe(false);
    expect(canControlGuild('["100"]', null)).toBe(false);
  });

  it("treats missing and disabled guild rows as unavailable", async () => {
    const bind = vi.fn();
    const first = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ enabled: 0 })
      .mockResolvedValueOnce({ enabled: 1 });
    bind.mockReturnValue({ first });
    const prepare = vi.fn().mockReturnValue({ bind });
    const repository = new GuildAccessRepository({
      prepare,
    } as unknown as D1Database);

    await expect(repository.isEnabled("guild")).resolves.toBe(false);
    await expect(repository.isEnabled("guild")).resolves.toBe(false);
    await expect(repository.isEnabled("guild")).resolves.toBe(true);
  });
});
