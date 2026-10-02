export type JobTimingMetrics = {
  attachmentDownloadMs: number;
  transcriptionMs: number;
  metadataAnalysisMs: number;
  stationCandidateMs: number;
  stationReconciliationMs: number;
  normalizationMs: number;
  clipSaveMs: number;
  resultDeliveryMs: number;
  totalMs: number;
};
export const newJobTimingMetrics = (): JobTimingMetrics => ({
  attachmentDownloadMs: 0,
  transcriptionMs: 0,
  metadataAnalysisMs: 0,
  stationCandidateMs: 0,
  stationReconciliationMs: 0,
  normalizationMs: 0,
  clipSaveMs: 0,
  resultDeliveryMs: 0,
  totalMs: 0,
});
export const timingField: Record<string, keyof JobTimingMetrics> = {
  attachment_download: "attachmentDownloadMs",
  attachment_download_for_result: "attachmentDownloadMs",
  whisper_transcription: "transcriptionMs",
  gemini_analysis: "metadataAnalysisMs",
  station_candidates_sequences: "stationCandidateMs",
  gemini_normalization: "normalizationMs",
  clip_save: "clipSaveMs",
  result_notification: "resultDeliveryMs",
};
