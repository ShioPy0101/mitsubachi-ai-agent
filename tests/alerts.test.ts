import { describe, expect, it } from "vitest";
import { formatAudioJobAlert } from "../src/jobs/alerts";
import {
  formatStationCandidateJobProgress,
  stationCandidatePerformanceWarning,
} from "../src/jobs/station-observability";
import type { StationSequenceMetrics } from "../src/stations/candidate-service";

const metrics = (
  overrides: Partial<StationSequenceMetrics> = {},
): StationSequenceMetrics => ({
  mentions: 7,
  surfaceCandidateCount: 12,
  phoneticCandidateCount: 2,
  uniqueCandidateCount: 13,
  lineIdsLoaded: 1,
  routeHypothesesGenerated: 2,
  routeHypothesesKept: 2,
  graphSearchCount: 0,
  fallbackExecuted: false,
  fallbackSeedCount: 0,
  alignmentRouteCount: 2,
  alignmentComparisonCount: 2_700,
  d1QueryCount: 3,
  candidateGenerationMs: 5,
  lineLookupMs: 8,
  hypothesisGenerationMs: 0,
  graphSearchMs: 0,
  alignmentMs: 23,
  reconciliationMs: 0,
  totalMs: 61,
  ...overrides,
});

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

  it("formats warnings separately from errors", () => {
    const content = formatAudioJobAlert({
      jobId: "job-id",
      stage: "station_candidates_sequences",
      severity: "warning",
      errorName: "StationCandidatePerformanceWarning",
      errorMessage: "sequence=6 total=12000ms",
    });

    expect(content).toContain("⚠️ audio job warning");
    expect(content).toContain("sequence=6 total=12000ms");
  });

  it("summarizes station work for the job monitor and alerts only on abnormal cost", () => {
    const normal = [{ id: 5, metrics: metrics() }];
    const detail = formatStationCandidateJobProgress(normal, 80);

    expect(detail).toContain("1 sequences・7 mentions・phase 80ms");
    expect(detail).toContain("D1 3・graph 0・fallback 0");
    expect(detail).toContain("最遅 #5 61ms/D1 3");
    expect(stationCandidatePerformanceWarning(normal, 80)).toBeNull();

    const slow = [
      {
        id: 6,
        metrics: metrics({
          totalMs: 12_000,
          d1QueryCount: 18,
          alignmentComparisonCount: 150_000,
          graphSearchCount: 1,
          fallbackExecuted: true,
        }),
      },
    ];
    expect(stationCandidatePerformanceWarning(slow, 12_500)).toContain(
      "sequence=6 total=12000ms mentions=7 D1=18 rowsRead=unavailable candidate=5ms line=8ms graphMs=0ms graph=1 fallback=true hypotheses=2 alignment=150000",
    );
  });
});
