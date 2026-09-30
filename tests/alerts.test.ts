import { describe, expect, it } from "vitest";
import { formatAudioJobAlert } from "../src/jobs/alerts";

describe("audio job alerts", () => {
  it("includes operational context and stays within Discord's message limit", () => {
    const content = formatAudioJobAlert({
      jobId: "job-id",
      stage: "gemini_metadata",
      attempt: 1,
      errorName: "GeminiApiError",
      errorMessage: "x".repeat(3_000),
    });

    expect(content).toContain("job: job-id");
    expect(content).toContain("stage: gemini_metadata");
    expect(content).toContain("attempt: 1");
    expect(content).toContain("GeminiApiError:");
    expect(content.length).toBeLessThanOrEqual(1900);
  });

  it("includes enqueue failure context without a job ID", () => {
    const content = formatAudioJobAlert({
      interactionId: "interaction-id",
      guildId: "guild-id",
      attachmentId: "attachment-id",
      filename: "17.mp3",
      stage: "enqueue",
      errorName: "Error",
      errorMessage: "D1 insert failed",
    });

    expect(content).toContain("interaction: interaction-id");
    expect(content).toContain("guild: guild-id");
    expect(content).toContain("attachment: attachment-id");
    expect(content).toContain("file: 17.mp3");
    expect(content).toContain("stage: enqueue");
    expect(content).toContain("Error:\nD1 insert failed");
  });
});
