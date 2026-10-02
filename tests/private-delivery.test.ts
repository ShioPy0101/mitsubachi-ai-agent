import { describe, expect, it, vi } from "vitest";
import { notify } from "../src/pipeline/delivery";
import type { DiscordRestClient } from "../src/discord/rest-client";
import type { AudioJob } from "../src/jobs/types";

const job: AudioJob = {
  id: "private-job",
  source: {
    type: "interaction",
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    interactionId: "interaction",
    attachmentId: "attachment",
    temporaryReference: null,
  },
  originalFilename: "audio.mp3",
  contentType: "audio/mpeg",
  sizeBytes: 1,
  durationSecs: 1,
  status: "metadata_extracting",
  errorMessage: null,
  transcriptionText: null,
  createdAt: new Date().toISOString(),
  startedAt: null,
  completedAt: null,
};
describe("private interaction delivery", () => {
  for (const scenario of ["missing", "expired", "rejected", "network"] as const)
    it(`never posts private content to a channel when the callback is ${scenario}`, async () => {
      const callbacks = {
        get: vi.fn().mockResolvedValue(
          scenario === "missing"
            ? null
            : {
                token: "token",
                expiresAt: new Date(
                  Date.now() + (scenario === "expired" ? -1000 : 60000),
                ).toISOString(),
              },
        ),
      };
      const discord = {
        editOriginalResponse:
          scenario === "network"
            ? vi.fn().mockRejectedValue(new Error("network"))
            : vi
                .fn()
                .mockResolvedValue({
                  ok: false,
                  status: 404,
                  responseBody: "unknown webhook",
                }),
        sendChannelMessage: vi.fn(),
      };
      expect(
        await notify(
          job,
          "private result",
          callbacks,
          discord as unknown as DiscordRestClient,
          {
            data: new ArrayBuffer(1),
            filename: "private.mp3",
            contentType: "audio/mpeg",
          },
        ),
      ).toBe(false);
      expect(discord.sendChannelMessage).not.toHaveBeenCalled();
      if (scenario === "missing" || scenario === "expired")
        expect(discord.editOriginalResponse).not.toHaveBeenCalled();
    });
});
