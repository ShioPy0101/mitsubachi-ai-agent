import { describe, expect, it } from "vitest";
import {
  whisperProcessingTimeoutMs,
  jobProcessingTimeoutMs,
  JobDeadlineExceededError,
  AudioJobProcessingTimeoutError,
} from "../src/jobs/processing-timeout";
import { classifyFailure } from "../src/pipeline/failures";
import { GeminiApiError } from "../src/metadata/gemini";
import {
  formatPublicProgress,
  formatPublicFailure,
} from "../src/discord/presentation";
describe("offline deadline retry presentation policies", () => {
  it("provides downstream budget beyond the full 14-minute provider request", () => {
    expect(whisperProcessingTimeoutMs(1000)).toBe(14 * 60_000);
    expect(jobProcessingTimeoutMs(1000)).toBe(20 * 60_000);
    expect(whisperProcessingTimeoutMs(null)).toBe(10 * 60_000);
  });
  it("separates job and stage failure codes from retry", () => {
    expect(
      classifyFailure(new JobDeadlineExceededError(1), "normalizing"),
    ).toEqual({ failureCode: "job_deadline_exceeded", retryPolicy: "never" });
    expect(
      classifyFailure(new AudioJobProcessingTimeoutError(1), "normalizing")
        .failureCode,
    ).toBe("stage_timeout");
    expect(
      classifyFailure(new GeminiApiError(429, "retry"), "gemini_normalization")
        .retryPolicy,
    ).toBe("retry");
    expect(
      classifyFailure(
        new GeminiApiError(400, "invalid"),
        "gemini_normalization",
      ).retryPolicy,
    ).toBe("never");
  });
  it("keeps public errors independent of provider details", () => {
    expect(formatPublicProgress("gemini_analysis")).not.toMatch(
      /Gemini|D1|Whisper/,
    );
    expect(formatPublicFailure("database_failed")).not.toMatch(
      /Gemini|D1|Whisper/,
    );
  });
});

import { evaluateCorrections } from "../src/stations/evaluation";
it("measures precision recall false correction and unresolved independently", () => {
  const labels = [
    {
      mentionId: "a",
      sourceText: "安雪",
      expectedText: "野洲",
      requiresCorrection: true,
      hasCandidates: true,
    },
    {
      mentionId: "b",
      sourceText: "神話口",
      expectedText: "河和口",
      requiresCorrection: true,
      hasCandidates: true,
    },
    {
      mentionId: "c",
      sourceText: "東京",
      expectedText: "東京",
      requiresCorrection: false,
      hasCandidates: true,
    },
  ];
  expect(
    evaluateCorrections(labels, [
      { mentionId: "a", text: "野洲" },
      { mentionId: "c", text: "京都" },
    ]),
  ).toMatchObject({
    precision: 0.5,
    recall: 0.5,
    falseCorrectionRate: 1,
    unresolvedRate: 1 / 3,
  });
  expect(evaluateCorrections([], []).precision).toBeNull();
});
