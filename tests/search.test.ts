import { describe, expect, it } from "vitest";
import { escapedLike } from "../src/db/clips-repository";
import { formatSearchResults } from "../src/discord/messages";

describe("search", () => {
  it("escapes LIKE metacharacters", () => {
    expect(escapedLike("五十%_\\丘")).toBe("%五十\\%\\_\\\\丘%");
  });

  it("formats at most repository-provided results", () => {
    const output = formatSearchResults([{
      station: "五十鈴ヶ丘", line: "JR参宮線", trainType: "普通", trainName: null,
      destination: "鳥羽", departureTime: "13:25", nextStation: "二見浦", summary: "次は二見浦",
      rawTranscription: "次は二見浦です", generatedFilename: "001.mp3",
    }]);
    expect(output).toContain("1. 五十鈴ヶ丘 / JR参宮線 / 普通 / 鳥羽行き");
    expect(output).toContain("13:25発");
  });
});
