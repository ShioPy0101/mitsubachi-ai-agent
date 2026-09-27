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
});
