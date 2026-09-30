import { describe, expect, it } from "vitest";
import { isSupportedAudioAttachment } from "../src/discord/attachments";
import { deferredResponse, parsePlatformCommand } from "../src/discord/interactions";
import { verifyDiscordSignature } from "../src/discord/signatures";

const interaction = {
  id: "100",
  application_id: "200",
  type: 2,
  token: "callback-token",
  guild_id: "300",
  channel_id: "400",
  member: { user: { id: "600" } },
  data: {
    name: "platform-ai-agent",
    options: [{ name: "audio", type: 11, value: "500" }],
    resolved: {
      attachments: {
        "500": {
          id: "500", filename: "station.mp3", size: 1024,
          url: "https://cdn.discordapp.com/attachments/test/station.mp3",
          content_type: "audio/mpeg",
        },
      },
    },
  },
};

describe("/platform-ai-agent interaction", () => {
  it("parses the required attachment into the interaction source", () => {
    const result = parsePlatformCommand(interaction);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("audio");
    if (result.value.kind !== "audio") return;
    expect(result.value.interactionId).toBe("100");
    expect(result.value.attachment.id).toBe("500");
    expect(result.value.userId).toBe("600");
    expect(isSupportedAudioAttachment(result.value.attachment)).toBe(true);
  });

  it("rejects a missing attachment", () => {
    const result = parsePlatformCommand({ ...interaction, data: { name: "platform-ai-agent", options: [] } });
    expect(result).toEqual({ ok: false, error: "audio添付は必須です。" });
  });

  it("rejects commands other than platform-ai-agent", () => {
    const result = parsePlatformCommand({ ...interaction, data: { ...interaction.data, name: "platform" } });
    expect(result).toEqual({ ok: false, error: "未対応のコマンドです。" });
  });

  it("uses the audio option value as the resolved attachment ID", () => {
    const result = parsePlatformCommand({
      ...interaction,
      data: {
        ...interaction.data,
        options: [{ name: "audio", type: 11, value: "501" }],
      },
    });
    expect(result).toEqual({ ok: false, error: "audio添付を読み取れませんでした。" });
  });

  it("parses allow and deny access subcommands with their actor", () => {
    for (const action of ["allow", "deny"] as const) {
      const result = parsePlatformCommand({
        ...interaction,
        data: {
          ...interaction.data,
          name: action === "allow" ? "platform-ai-agent-allow" : "platform-ai-agent-deny",
          options: [],
        },
      });
      expect(result).toEqual({
        ok: true,
        value: { kind: "access", action, guildId: "300", userId: "600" },
      });
    }
  });

  it("parses the owner demo as a distinct non-persistent command", () => {
    const result = parsePlatformCommand({
      ...interaction,
      data: { ...interaction.data, name: "platform-ai-agent-demo" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      kind: "demo",
      interactionId: "100",
      interactionToken: "callback-token",
      userId: "600",
      attachment: { id: "500", filename: "station.mp3" },
    });
  });

  it("rejects unsupported MIME or extension combinations", () => {
    expect(isSupportedAudioAttachment({
      id: "1", filename: "station.exe", size: 1, url: "https://example.com/a", contentType: "audio/mpeg", durationSecs: null,
    })).toBe(false);
    expect(isSupportedAudioAttachment({
      id: "1", filename: "station.mp3", size: 1, url: "https://example.com/a", contentType: "application/octet-stream", durationSecs: null,
    })).toBe(true);
    expect(isSupportedAudioAttachment({
      id: "1", filename: "station.mp3", size: 1, url: "https://example.com/a", contentType: "audio/mp3; charset=binary", durationSecs: null,
    })).toBe(true);
    expect(isSupportedAudioAttachment({
      id: "1", filename: "station.mp3", size: 1, url: "https://example.com/a", contentType: "image/png", durationSecs: null,
    })).toBe(false);
  });

  it("creates a public Discord deferred ACK", async () => {
    const response = deferredResponse();
    expect(await response.json()).toEqual({ type: 5 });
  });

  it("rejects malformed signatures", async () => {
    await expect(verifyDiscordSignature("00", "00", "123", "{}")).resolves.toBe(false);
  });
});
