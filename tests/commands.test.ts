import { describe, expect, it } from "vitest";
import { discordCommands } from "../src/discord/commands";

describe("Discord command registration", () => {
  it("preserves the flat audio command and registers separate access commands", () => {
    const platform = discordCommands.find((command) => command.name === "platform-ai-agent");
    expect(platform?.options.map((option) => [option.name, option.type])).toEqual([
      ["audio", 11],
    ]);
    expect(discordCommands.map((command) => command.name)).toContain("platform-ai-agent-allow");
    expect(discordCommands.map((command) => command.name)).toContain("platform-ai-agent-deny");
  });
});
