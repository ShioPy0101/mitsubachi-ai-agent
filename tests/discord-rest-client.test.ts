import { describe, expect, it, vi } from "vitest";
import {
  DiscordRequestTimeoutError,
  DiscordRestClient,
} from "../src/discord/rest-client";

describe("DiscordRestClient", () => {
  it("times out stalled Discord requests", async () => {
    const fetcher = async (): Promise<Response> => new Promise(() => undefined);
    const client = new DiscordRestClient(
      "bot-token",
      "application-id",
      fetcher,
      5,
    );

    await expect(
      client.sendChannelMessage("channel-id", "message"),
    ).rejects.toEqual(new DiscordRequestTimeoutError(5));
  });

  it("does not bind the global fetch function to the client instance", async () => {
    const globalFetcher = vi.fn(function (this: unknown) {
      expect(this).not.toBeInstanceOf(DiscordRestClient);
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    vi.stubGlobal("fetch", globalFetcher);
    try {
      const client = new DiscordRestClient("bot-token", "application-id");
      await expect(
        client.editOriginalResponse("interaction-token", "working"),
      ).resolves.toEqual({ ok: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("edits the deferred original interaction response", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const client = new DiscordRestClient(
      "bot-token",
      "application-id",
      fetcher,
    );

    await expect(
      client.editOriginalResponse("interaction-token", "done"),
    ).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith(
      "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "done",
          allowed_mentions: { parse: [] },
        }),
      },
    );
  });

  it("edits the response with a renamed audio attachment", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const client = new DiscordRestClient(
      "bot-token",
      "application-id",
      fetcher,
    );

    await expect(
      client.editOriginalResponse("interaction-token", "done", {
        data: new Uint8Array([1, 2, 3]).buffer,
        filename: "001_中本行き.mp3",
        contentType: "audio/mpeg",
      }),
    ).resolves.toEqual({ ok: true });

    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("PATCH");
    expect(request.headers).toBeUndefined();
    expect(request.body).toBeInstanceOf(FormData);
    const form = request.body as FormData;
    expect(JSON.parse(String(form.get("payload_json")))).toEqual({
      content: "done",
      allowed_mentions: { parse: [] },
      attachments: [{ id: 0, filename: "001_中本行き.mp3" }],
    });
    const file = form.get("files[0]");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("001_中本行き.mp3");
    expect((file as File).type).toBe("audio/mpeg");
    expect((file as File).size).toBe(3);
  });

  it("sends interaction followups without exposing bot authorization", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const client = new DiscordRestClient(
      "bot-token",
      "application-id",
      fetcher,
    );

    await expect(
      client.sendInteractionFollowup("interaction-token", "debug"),
    ).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith(
      "https://discord.com/api/v10/webhooks/application-id/interaction-token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "debug",
          allowed_mentions: { parse: [] },
          flags: 64,
        }),
      },
    );
  });

  it("keeps diagnostic file followups ephemeral", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const client = new DiscordRestClient(
      "bot-token",
      "application-id",
      fetcher,
    );
    await client.sendInteractionFollowup("interaction-token", "debug file", {
      data: new ArrayBuffer(1),
      filename: "debug.md",
      contentType: "text/markdown",
    });
    const request = fetcher.mock.calls[0]![1] as RequestInit;
    const form = request.body as FormData;
    expect(JSON.parse(String(form.get("payload_json")))).toMatchObject({
      flags: 64,
      attachments: [{ id: 0, filename: "debug.md" }],
    });
  });

  it("creates and edits a channel message with Discord components", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "message-id" }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const client = new DiscordRestClient(
      "bot-token",
      "application-id",
      fetcher,
    );
    const components = [
      {
        type: 1 as const,
        components: [
          {
            type: 2 as const,
            style: 4,
            custom_id: "admin_job_stop:job",
            label: "停止",
          },
        ],
      },
    ];

    await expect(
      client.createChannelMessage("channel-id", "running", components),
    ).resolves.toEqual({ ok: true, messageId: "message-id" });
    await expect(
      client.editChannelMessage("channel-id", "message-id", "done", components),
    ).resolves.toEqual({ ok: true });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://discord.com/api/v10/channels/channel-id/messages",
      {
        method: "POST",
        headers: {
          Authorization: "Bot bot-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: "running",
          components,
          allowed_mentions: { parse: [] },
        }),
      },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://discord.com/api/v10/channels/channel-id/messages/message-id",
      {
        method: "PATCH",
        headers: {
          Authorization: "Bot bot-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: "done",
          components,
          allowed_mentions: { parse: [] },
        }),
      },
    );
  });

  it("returns Discord error details without throwing them away", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('{"message":"Unknown Webhook","code":10015}', {
        status: 404,
      }),
    );
    const client = new DiscordRestClient(
      "bot-token",
      "application-id",
      fetcher,
    );

    await expect(
      client.editOriginalResponse("interaction-token", "done"),
    ).resolves.toEqual({
      ok: false,
      status: 404,
      responseBody: '{"message":"Unknown Webhook","code":10015}',
    });
  });

  it("includes the HTTP status when an attachment cannot be downloaded", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("expired", { status: 403 }));
    const client = new DiscordRestClient(
      "bot-token",
      "application-id",
      fetcher,
    );

    await expect(
      client.downloadTemporaryAttachment(
        {
          id: "attachment-id",
          filename: "audio.wav",
          size: 100,
          url: "https://cdn.discordapp.com/audio.wav",
          contentType: "audio/wav",
          durationSecs: null,
        },
        1_000,
      ),
    ).rejects.toMatchObject({
      name: "AttachmentUnavailableError",
      reason: "attachment_unavailable",
      status: 403,
      message: "attachment_unavailable (HTTP 403)",
    });
  });
});
