import { DiscordRestClient } from "../discord/rest-client";

export type AudioJobAlert = {
  jobId?: string;
  interactionId?: string;
  guildId?: string | null;
  attachmentId?: string;
  filename?: string;
  stage: string;
  attempt?: number;
  severity?: "error" | "warning";
  errorName: string;
  errorMessage: string;
};

export function formatAudioJobAlert(alert: AudioJobAlert): string {
  const header = [
    alert.severity === "warning"
      ? "⚠️ audio job warning"
      : "🚨 audio job error",
    ...(alert.jobId === undefined ? [] : [`job: ${alert.jobId}`]),
    ...(alert.interactionId === undefined
      ? []
      : [`interaction: ${alert.interactionId}`]),
    ...(alert.guildId === undefined
      ? []
      : [`guild: ${alert.guildId ?? "none"}`]),
    ...(alert.attachmentId === undefined
      ? []
      : [`attachment: ${alert.attachmentId}`]),
    ...(alert.filename === undefined ? [] : [`file: ${alert.filename}`]),
    `stage: ${alert.stage}`,
    ...(alert.attempt === undefined ? [] : [`attempt: ${alert.attempt}`]),
    `${alert.errorName}:`,
  ].join("\n");
  const maximumMessageLength = Math.max(0, 1900 - header.length - 1);
  return `${header}\n${alert.errorMessage.slice(0, maximumMessageLength)}`;
}

export async function sendAudioJobAlert(
  env: Env,
  alert: AudioJobAlert,
): Promise<void> {
  const channelId = env.DISCORD_ALERT_CHANNEL_ID?.trim();
  if (!channelId) return;
  try {
    const discord = new DiscordRestClient(
      env.DISCORD_BOT_TOKEN,
      env.DISCORD_APPLICATION_ID,
    );
    const result = await discord.sendChannelMessage(
      channelId,
      formatAudioJobAlert(alert),
    );
    if (!result.ok) {
      console.error("audio_job_alert_failed", {
        stage: alert.stage,
        status: result.status,
        responseBody: result.responseBody,
      });
    }
  } catch (error) {
    console.error("audio_job_alert_failed", {
      stage: alert.stage,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
