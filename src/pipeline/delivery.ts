import { formatPublicProgress } from "../discord/presentation";

import {
  AttachmentUnavailableError,
  DiscordRestClient,
  type DiscordFile,
} from "../discord/rest-client";

import {
  formatDemoDiagnosticPreviews,
  formatDemoDiagnostics,
  type DemoDiagnostics,
} from "../discord/demo-diagnostics";

import { formatAnalysisResult } from "../discord/messages";

import { formatAudioJobAlert } from "../jobs/alerts";

import type { AudioJob } from "../jobs/types";

import { stageTimeouts, type ProcessingCallbacks } from "./resources";
import { errorDetails, runStage } from "./stage-runner";
export async function sendAlert(
  env: Env,
  discord: DiscordRestClient,
  jobId: string,
  stage: string,
  error: unknown,
  attempt?: number,
  severity: "error" | "warning" = "error",
): Promise<void> {
  const channelId = env.DISCORD_ALERT_CHANNEL_ID?.trim();

  if (!channelId) {
    return;
  }

  const details = errorDetails(error);

  try {
    const result = await discord.sendChannelMessage(
      channelId,
      formatAudioJobAlert({
        jobId,
        stage,
        ...(attempt === undefined ? {} : { attempt }),
        severity,
        ...details,
      }),
    );

    if (!result.ok) {
      console.error("audio_job_alert_failed", {
        jobId,
        stage,
        status: result.status,
        responseBody: result.responseBody,
      });
    }
  } catch (alertError) {
    console.error("audio_job_alert_failed", {
      jobId,
      stage,
      ...errorDetails(alertError),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Attachment helpers                                                         */
/* -------------------------------------------------------------------------- */

export function maxAudioBytes(env: Env): number {
  const parsed = Number(env.MAX_AUDIO_BYTES);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 25 * 1024 * 1024;
}

export function attachmentFor(job: AudioJob): {
  id: string;
  filename: string;
  size: number;
  url: string;
  contentType: string | null;
  durationSecs: number | null;
} {
  const reference = job.source.temporaryReference;

  if (reference === null) {
    throw new AttachmentUnavailableError("attachment_unavailable");
  }

  if (
    reference.expiresAt !== null &&
    Date.parse(reference.expiresAt) <= Date.now()
  ) {
    throw new AttachmentUnavailableError("attachment_unavailable");
  }

  return {
    id: job.source.attachmentId,
    filename: job.originalFilename,
    size: job.sizeBytes,
    url: reference.url,
    contentType: job.contentType,
    durationSecs: job.durationSecs,
  };
}

/* -------------------------------------------------------------------------- */
/* Discord response helpers                                                   */
/* -------------------------------------------------------------------------- */

async function editOriginalResponse(
  job: AudioJob,
  content: string,
  callbacks: ProcessingCallbacks,
  discord: DiscordRestClient,
  kind: "progress" | "result",
  file?: DiscordFile,
): Promise<boolean> {
  const callback = await runStage(
    job.id,
    "discord_callback_lookup",
    () => callbacks.get(job.id),
    undefined,
    stageTimeouts.discordCallbackLookup,
  );

  if (callback !== null && Date.parse(callback.expiresAt) > Date.now()) {
    try {
      const result = await discord.editOriginalResponse(
        callback.token,
        content,
        file,
      );

      if (result.ok) {
        console.info("audio_job_discord_original_edited", {
          jobId: job.id,
          kind,
        });

        return true;
      }

      console.error("audio_job_discord_original_edit_failed", {
        jobId: job.id,
        kind,
        status: result.status,
        responseBody: result.responseBody,
      });
    } catch (error) {
      console.error("audio_job_discord_original_edit_failed", {
        jobId: job.id,
        kind,
        ...errorDetails(error),
      });
    }
  } else {
    console.warn("audio_job_discord_callback_unavailable", {
      jobId: job.id,
      kind,
      reason: callback === null ? "missing" : "expired",
    });
  }

  return false;
}

const progressProjection = new WeakMap<
  AudioJob,
  { text: string; at: number }
>();
export async function updateProgress(
  job: AudioJob,
  content: string,
  callbacks: ProcessingCallbacks,
  discord: DiscordRestClient,
  _asFollowup = false,
): Promise<void> {
  try {
    const purpose = /ファイル|取得/u.test(content)
      ? "attachment_download"
      : /文字起こし|MP3|decode|フレーム/u.test(content)
        ? "whisper_transcription"
        : /文面/u.test(content)
          ? "gemini_normalization"
          : /地理空間|経路/u.test(content)
            ? "station_candidates_sequences"
            : /構造|メタデータ/u.test(content)
              ? "gemini_analysis"
              : /結果|組み立て/u.test(content)
                ? "clip_save"
                : "processing";
    const text = _asFollowup ? `🔧 ${content}` : formatPublicProgress(purpose);
    const previous = progressProjection.get(job);
    if (previous?.text === text && Date.now() - previous.at < 30_000) return;
    progressProjection.set(job, { text, at: Date.now() });
    await editOriginalResponse(job, text, callbacks, discord, "progress");
  } catch (error) {
    console.error("audio_job_progress_update_failed", {
      jobId: job.id,
      ...errorDetails(error),
    });
  }
}

export async function notify(
  job: AudioJob,
  content: string,
  callbacks: ProcessingCallbacks,
  discord: DiscordRestClient,
  file?: DiscordFile,
): Promise<boolean> {
  const originalEdited = await editOriginalResponse(
    job,
    content,
    callbacks,
    discord,
    "result",
    file,
  );

  if (originalEdited) {
    return true;
  }

  if (job.source.channelId !== null) {
    try {
      const result = await discord.sendChannelMessage(
        job.source.channelId,
        content,
        file,
      );

      if (result.ok) {
        console.info("audio_job_discord_channel_sent", {
          jobId: job.id,
        });

        return true;
      }

      console.error("audio_job_discord_channel_send_failed", {
        jobId: job.id,
        status: result.status,
        responseBody: result.responseBody,
      });
    } catch (error) {
      console.error("audio_job_discord_channel_send_failed", {
        jobId: job.id,
        ...errorDetails(error),
      });
    }
  }

  return false;
}

export async function notifyDemo(
  job: AudioJob,
  diagnostics: DemoDiagnostics,
  callbacks: ProcessingCallbacks,
  discord: DiscordRestClient,
  file: DiscordFile,
): Promise<boolean> {
  const callback = await runStage(
    job.id,
    "discord_callback_lookup",
    () => callbacks.get(job.id),
    undefined,
    stageTimeouts.discordCallbackLookup,
  );

  if (callback === null || Date.parse(callback.expiresAt) <= Date.now()) {
    return false;
  }

  const messages = formatDemoDiagnostics(diagnostics);

  const result = await discord.editOriginalResponse(
    callback.token,
    formatAnalysisResult(
      diagnostics.metadata,
      diagnostics.normalizedTranscription,
      diagnostics.filename,
    ),
    file,
  );

  if (!result.ok) {
    console.error("demo_diagnostics_original_edit_failed", {
      jobId: job.id,
      status: result.status,
      responseBody: result.responseBody,
    });

    return false;
  }

  const debugMarkdown = [
    "# platform-ai-agent-demo debug output",
    "",
    ...messages,
  ].join("\n\n");

  const encodedDebug = new TextEncoder().encode(debugMarkdown);

  const debugFileResult = await discord.sendInteractionFollowup(
    callback.token,
    "📎 完全なデバッグ出力です。画面上の表示は各項目の先頭部分だけに制限しています。",
    {
      data: encodedDebug.buffer.slice(
        encodedDebug.byteOffset,
        encodedDebug.byteOffset + encodedDebug.byteLength,
      ) as ArrayBuffer,
      filename: "platform-ai-agent-demo-debug.md",
      contentType: "text/markdown; charset=utf-8",
    },
  );

  if (!debugFileResult.ok) {
    console.error("demo_diagnostics_file_failed", {
      jobId: job.id,
      status: debugFileResult.status,
      responseBody: debugFileResult.responseBody,
    });
  }

  const previewMessages = formatDemoDiagnosticPreviews(diagnostics);

  for (let index = 0; index < previewMessages.length; index += 1) {
    const followup = await discord.sendInteractionFollowup(
      callback.token,
      previewMessages[index]!,
    );

    if (!followup.ok) {
      console.error("demo_diagnostics_followup_failed", {
        jobId: job.id,
        index,
        status: followup.status,
        responseBody: followup.responseBody,
      });

      break;
    }
  }

  return true;
}

/* -------------------------------------------------------------------------- */
/* User-visible messages                                                      */
/* -------------------------------------------------------------------------- */

export const rejectedContentMessage =
  "この音声は利用条件に合わないため処理できませんでした。";

export const emptyTranscriptionMessage =
  "音声から文字を認識できませんでした。別の音声ファイルでお試しください。";

export const staleJobMessage =
  "音声処理がタイムアウトしたため停止しました。お手数ですが、もう一度コマンドを実行してください。";

export function formatDemoFailure(
  error: unknown,
  stage: string,
  attempt: number,
): string {
  const details = errorDetails(error);

  const message = details.errorMessage
    .slice(0, 1_300)
    .replaceAll("```", "``\u200b`");

  const retrySummary = stage.startsWith("gemini_")
    ? "同じ文字起こしを使ったGemini再試行（最大3回）も完了できませんでした。"
    : details.errorName === "WhisperAudioDecodeError"
      ? "MP3原本の3030エラー後、MP3フレームのみ再構成した再送もdecodeできませんでした。WAV変換は行っていません。"
      : "この失敗では処理全体を再実行しません。";

  return [
    "❌ **デモ処理に失敗しました**",
    "",
    `失敗ステージ: \`${stage}\``,
    `エラー種別: \`${details.errorName}\``,
    `Queue受信回数: ${attempt}`,
    `再試行: ${retrySummary}`,
    "Queueへの再投入: なし（同じ音声の再文字起こしは行いません）",
    "",
    "エラー内容:",
    `\`\`\`text\n${message}\n\`\`\``,
  ].join("\n");
}
