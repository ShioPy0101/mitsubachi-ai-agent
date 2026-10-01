import { describe, expect, it } from "vitest";
import { formatAnalysisResult } from "../src/discord/messages";
import type { RailwayAnnouncementMetadata } from "../src/railway/types";

describe("Discord messages", () => {
  it("shows the generated filename in a code block", () => {
    const metadata: RailwayAnnouncementMetadata = {
      station: null,
      line: null,
      trainType: null,
      trainName: null,
      trainNumber: null,
      destination: null,
      departureTime: null,
      arrivalTime: null,
      platform: null,
      nextStation: null,
      category: "general_information",
      summary: "列車接近",
    };

    expect(
      formatAnalysisResult(
        metadata,
        "列車がまいります",
        "001_各駅停車大船行き.wav",
      ),
    ).toContain("ファイル名:\n```text\n001_各駅停車大船行き.wav\n```");
  });
});
