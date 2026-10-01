import { describe, expect, it } from "vitest";
import {
  generateRailwayFilename,
  sanitizeFilenamePart,
} from "../src/railway/filename";
import type { RailwayAnnouncementMetadata } from "../src/railway/types";

const metadata: RailwayAnnouncementMetadata = {
  station: null,
  line: "花咲線",
  trainType: "普通",
  trainName: null,
  trainNumber: null,
  destination: "根室",
  departureTime: "13:25",
  arrivalTime: null,
  platform: null,
  nextStation: "西和田",
  category: "departure",
  summary: "次は西和田",
};

describe("filename", () => {
  it("generates a deterministic railway filename", () => {
    expect(generateRailwayFilename(metadata, "recording.mp3")).toBe(
      "花咲線_普通_根室行き_13時25分発_次は西和田.mp3",
    );
  });

  it("removes Discord code fence characters from filename parts", () => {
    expect(sanitizeFilenamePart("大船`行き")).toBe("大船_行き");
  });

  it("uses the announcement type when detailed metadata is unavailable", () => {
    const empty = Object.fromEntries(
      Object.keys(metadata).map((key) => [key, null]),
    );
    const valid = {
      ...empty,
      category: "delay",
    } as RailwayAnnouncementMetadata;
    expect(generateRailwayFilename(valid, "audio.mp3")).toBe("運行情報.mp3");
  });

  it("includes useful train, arrival and platform details", () => {
    const detailed = {
      ...metadata,
      trainName: "快速エアポート",
      trainNumber: "123号",
      departureTime: null,
      arrivalTime: "09:05",
      platform: "3番線",
    };
    expect(generateRailwayFilename(detailed, "audio.wav")).toBe(
      "花咲線_快速エアポート_123号_普通_根室行き_9時05分着_3番線_次は西和田.wav",
    );
  });

  it("sanitizes forbidden characters, underscores and edges", () => {
    expect(sanitizeFilenamePart(' ._ A/B:*?"<>|__C _. ')).toBe("A_B_C");
    expect(sanitizeFilenamePart("abcdef", 3)).toBe("abc");
  });
});
