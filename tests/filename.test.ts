import { describe, expect, it } from "vitest";
import { generateRailwayFilename, sanitizeFilenamePart } from "../src/railway/filename";
import type { RailwayAnnouncementMetadata } from "../src/railway/types";

const metadata: RailwayAnnouncementMetadata = {
  station: null, line: "花咲線", trainType: "普通", trainName: null, trainNumber: null,
  destination: "根室", departureTime: "13:25", arrivalTime: null, platform: null,
  nextStation: "西和田", category: "departure", summary: "次は西和田",
};

describe("filename", () => {
  it("generates a deterministic railway filename", () => {
    expect(generateRailwayFilename(1, metadata, "recording.mp3")).toBe(
      "001_花咲線_普通_根室行き_1325発_次は西和田.mp3",
    );
  });

  it("removes Discord code fence characters from filename parts", () => {
    expect(sanitizeFilenamePart("大船`行き")).toBe("大船_行き");
  });

  it("omits nulls and uses the fallback", () => {
    const empty = Object.fromEntries(Object.keys(metadata).map((key) => [key, null]));
    const valid = { ...empty, category: "other" } as RailwayAnnouncementMetadata;
    expect(generateRailwayFilename(1, valid, "audio.mp3")).toBe("001_交通案内.mp3");
  });

  it("sanitizes forbidden characters, underscores and edges", () => {
    expect(sanitizeFilenamePart(" ._ A/B:*?\"<>|__C _. ")).toBe("A_B_C");
    expect(sanitizeFilenamePart("abcdef", 3)).toBe("abc");
  });
});
