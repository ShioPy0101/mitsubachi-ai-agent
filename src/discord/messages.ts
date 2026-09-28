import type { ClipSearchResult } from "../db/clips-repository";
import type { RailwayAnnouncementMetadata } from "../railway/types";

const present = (values: Array<string | null>): string => values.filter((value): value is string => value !== null).join(" / ");

export function formatAnalysisResult(
  metadata: RailwayAnnouncementMetadata,
  transcription: string,
  filename: string,
): string {
  const heading = present([metadata.station, metadata.line, metadata.trainType, metadata.destination === null ? null : `${metadata.destination}行き`]);
  const time = metadata.departureTime === null ? null : `${metadata.departureTime}発`;
  return [
    "解析完了",
    "",
    heading || "交通案内",
    time,
    metadata.summary,
    "",
    `補正文字起こし:\n「${transcription.slice(0, 1200)}」`,
    `ファイル名:\n\`\`\`text\n${filename}\n\`\`\``,
  ].filter((line): line is string => line !== null).join("\n");
}

export function formatFailure(reason: "attachment_unavailable" | "processing_failed"): string {
  return reason === "attachment_unavailable"
    ? "音声ファイルを取得できませんでした。もう一度コマンドを実行してください。"
    : "音声の解析に失敗しました。時間をおいてもう一度お試しください。";
}

export function formatSearchResults(results: readonly ClipSearchResult[]): string {
  if (results.length === 0) return "該当する交通案内はありませんでした。";
  return results.map((result, index) => {
    const heading = present([result.station, result.line, result.trainType, result.destination === null ? null : `${result.destination}行き`]);
    const excerpt = result.rawTranscription.length > 100 ? `${result.rawTranscription.slice(0, 100)}…` : result.rawTranscription;
    return `${index + 1}. ${heading || "交通案内"}\n${result.departureTime === null ? "" : `${result.departureTime}発\n`}${result.summary ?? ""}\n「${excerpt}」`;
  }).join("\n\n");
}
