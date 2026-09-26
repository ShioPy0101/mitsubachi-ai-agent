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
    name: "platform",
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

describe("/platform interaction", () => {
  it("parses the required attachment into the interaction source", () => {
    const result = parseShioCommand(interaction);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.interactionId).toBe("100");
    expect(result.value.attachment.id).toBe("500");
    expect(isSupportedAudioAttachment(result.value.attachment)).toBe(true);
  });

  it("rejects a missing attachment", () => {
    const result = parseShioCommand({ ...interaction, data: { name: "platform", options: [] } });
    expect(result).toEqual({ ok: false, error: "audio添付は必須です。" });
  });

  it("rejects unsupported MIME or extension combinations", () => {
    expect(isSupportedAudioAttachment({
      id: "1", filename: "station.exe", size: 1, url: "https://example.com/a", contentType: "audio/mpeg", durationSecs: null,
    })).toBe(false);
    expect(isSupportedAudioAttachment({
      id: "1", filename: "station.mp3", size: 1, url: "https://example.com/a", contentType: "application/octet-stream", durationSecs: null,
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
