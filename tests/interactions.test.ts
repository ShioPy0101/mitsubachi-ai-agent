import { describe, expect, it } from "vitest";
import { isSupportedAudioAttachment } from "../src/discord/attachments";
import { deferredEphemeralResponse, parseShioCommand } from "../src/discord/interactions";
import { verifyDiscordSignature } from "../src/discord/signatures";

const interaction = {
  id: "100",
  application_id: "200",
  type: 2,
  token: "callback-token",
  guild_id: "300",
  channel_id: "400",
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
    const result = parseShioCommand(interaction);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.interactionId).toBe("100");
    expect(result.value.attachment.id).toBe("500");
    expect(isSupportedAudioAttachment(result.value.attachment)).toBe(true);
  });

  it("rejects a missing attachment", () => {
    const result = parseShioCommand({ ...interaction, data: { name: "platform-ai-agent", options: [] } });
    expect(result).toEqual({ ok: false, error: "audio添付は必須です。" });
  });

  it("rejects commands other than platform-ai-agent", () => {
    const result = parseShioCommand({ ...interaction, data: { ...interaction.data, name: "platform" } });
    expect(result).toEqual({ ok: false, error: "未対応のコマンドです。" });
  });

  it("uses the audio option value as the resolved attachment ID", () => {
    const result = parseShioCommand({
      ...interaction,
      data: {
        ...interaction.data,
        options: [{ name: "audio", type: 11, value: "501" }],
      },
    });
    expect(result).toEqual({ ok: false, error: "audio添付を読み取れませんでした。" });
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

  it("creates the Discord deferred ephemeral ACK", async () => {
    const response = deferredEphemeralResponse();
    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
  });

  it("rejects malformed signatures", async () => {
    await expect(verifyDiscordSignature("00", "00", "123", "{}")).resolves.toBe(false);
  });
});
