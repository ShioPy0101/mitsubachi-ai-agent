export type AudioJobAlert = {
  jobId: string;
  stage: string;
  attempt?: number;
  errorName: string;
  errorMessage: string;
};

export function formatAudioJobAlert(alert: AudioJobAlert): string {
  const header = [
    "🚨 audio job error",
    `job: ${alert.jobId}`,
    `stage: ${alert.stage}`,
    ...(alert.attempt === undefined ? [] : [`attempt: ${alert.attempt}`]),
    `${alert.errorName}:`,
  ].join("\n");
  const maximumMessageLength = Math.max(0, 1900 - header.length - 1);
  return `${header}\n${alert.errorMessage.slice(0, maximumMessageLength)}`;
}
