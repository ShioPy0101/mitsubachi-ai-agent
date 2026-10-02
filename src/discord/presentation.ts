import type { PresentationMode } from "../pipeline/modes";
const publicProgress: Record<string, string> = {
  attachment_download: "音声ファイルを確認しています…",
  whisper_transcription: "文字起こしを処理しています…",
  gemini_analysis: "内容を解析しています…",
  station_candidates_sequences: "駅名・経路情報を確認しています…",
  gemini_normalization: "内容を整えています…",
  clip_save: "結果を作成しています…",
  result_notification: "結果をお届けしています…",
};
export function formatPublicProgress(stage: string): string {
  return publicProgress[stage] ?? "音声の内容を処理しています…";
}
export function formatProgress(
  mode: PresentationMode,
  stage: string,
  detail?: string,
): string {
  return mode === "demo"
    ? `🔧 ${detail ?? stage}`
    : formatPublicProgress(stage);
}
export function formatPublicFailure(code: string): string {
  if (code === "attachment_unavailable")
    return "音声ファイルを取得できませんでした。もう一度お試しください。";
  if (code === "audio_decode_failed")
    return "音声を読み取れませんでした。音声ファイルを再保存してお試しください。";
  return "内容の解析中にエラーが発生しました。もう一度お試しください。";
}
