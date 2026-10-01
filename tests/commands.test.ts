import { describe, expect, it } from "vitest";
import { discordCommands } from "../src/discord/commands";

describe("Discord command registration", () => {
  it("preserves the flat audio command and registers separate access commands", () => {
    const platform = discordCommands.find(
      (command) => command.name === "platform-ai-agent",
    );
    expect(
      platform?.options.map((option) => [option.name, option.type]),
    ).toEqual([["audio", 11]]);
    expect(platform?.description).toBe("案内放送を登録");
    expect(platform?.options[0]?.description).toBe("音声ファイル");
    expect(discordCommands.map((command) => command.name)).toContain(
      "platform-ai-agent-allow",
    );
    expect(discordCommands.map((command) => command.name)).toContain(
      "platform-ai-agent-deny",
    );
  });

  it("keeps public commands public and defaults every management command to nobody", () => {
    for (const name of ["platform-ai-agent", "platform-search"]) {
      const command = discordCommands.find(
        (candidate) => candidate.name === name,
      );
      expect(command).not.toHaveProperty("default_member_permissions");
    }
    for (const name of [
      "platform-ai-agent-allow",
      "platform-ai-agent-deny",
      "platform-ai-agent-demo",
    ]) {
      const command = discordCommands.find(
        (candidate) => candidate.name === name,
      );
      expect(command).toMatchObject({
        default_member_permissions: "0",
        dm_permission: false,
      });
    }
  });
});
