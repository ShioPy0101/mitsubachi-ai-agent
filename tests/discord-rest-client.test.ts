import { describe, expect, it, vi } from "vitest";
import { DiscordRestClient } from "../src/discord/rest-client";

describe("DiscordRestClient", () => {
  it("does not bind the global fetch function to the client instance", async () => {
    const globalFetcher = vi.fn(function (this: unknown) {
      expect(this).not.toBeInstanceOf(DiscordRestClient);
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    vi.stubGlobal("fetch", globalFetcher);
    try {
      const client = new DiscordRestClient("bot-token", "application-id");
      await expect(client.editOriginalResponse("interaction-token", "working")).resolves.toEqual({ ok: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("edits the deferred original interaction response", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const client = new DiscordRestClient("bot-token", "application-id", fetcher);

    await expect(client.editOriginalResponse("interaction-token", "done")).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith(
      "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "done" }),
      },
    );
  });

  it("returns Discord error details without throwing them away", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"message":"Unknown Webhook","code":10015}', { status: 404 }));
    const client = new DiscordRestClient("bot-token", "application-id", fetcher);

    await expect(client.editOriginalResponse("interaction-token", "done")).resolves.toEqual({
      ok: false,
      status: 404,
      responseBody: '{"message":"Unknown Webhook","code":10015}',
    });
  });

  it("includes the HTTP status when an attachment cannot be downloaded", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("expired", { status: 403 }));
    const client = new DiscordRestClient("bot-token", "application-id", fetcher);

    await expect(client.downloadTemporaryAttachment({
      id: "attachment-id",
      filename: "audio.wav",
      size: 100,
      url: "https://cdn.discordapp.com/audio.wav",
      contentType: "audio/wav",
      durationSecs: null,
    }, 1_000)).rejects.toMatchObject({
      name: "AttachmentUnavailableError",
      reason: "attachment_unavailable",
      status: 403,
      message: "attachment_unavailable (HTTP 403)",
    });
  });
});
