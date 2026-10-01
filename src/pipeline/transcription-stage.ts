import type { DiscordRestClient } from "../discord/rest-client";
import type { JobMonitor } from "../jobs/job-monitor";
import { whisperProcessingTimeoutMs } from "../jobs/processing-timeout";
import type { AudioJob } from "../jobs/types";
import type { TranscriptionResult } from "../transcription/service";
import {
  CloudflareWhisperTranscriptionService,
  isMp3TranscriptionInput,
} from "../transcription/workers-ai";
import {
  attachmentFor,
  emptyTranscriptionMessage,
  maxAudioBytes,
  notify,
  updateProgress,
} from "./delivery";
import type { ProcessingResources } from "./resources";
import { stageTimeouts } from "./resources";
export type StageRun = <T>(
  stage: string,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs?: number,
) => Promise<T>;
export async function transcribeStage(
  job: AudioJob,
  env: Env,
  attempt: number,
  jobs: ProcessingResources["jobs"],
  callbacks: ProcessingResources["callbacks"],
  discord: DiscordRestClient,
  showDemoProgress: boolean,
  runJobStage: StageRun,
  monitor?: JobMonitor,
) {
  const attachment = attachmentFor(job);
  let audio: ArrayBuffer | null = null;
  let transcriptionText = job.transcriptionText;
  let transcriptionResult: TranscriptionResult | null = null;
  let needsTranscriptionCheckpoint = false;
  if (transcriptionText === null) {
    await jobs.updateStatus(job.id, "transcribing");

    await updateProgress(
      job,
      "音声ファイルを取得しています…",
      callbacks,
      discord,
      showDemoProgress,
    );

    audio = await runJobStage(
      "attachment_download",
      (signal) =>
        discord.downloadTemporaryAttachment(
          attachment,
          maxAudioBytes(env),
          signal,
        ),
      stageTimeouts.attachmentDownload,
    );

    const transcriptionInput = {
      audio: audio as ArrayBuffer,
      contentType: job.contentType,
      filename: job.originalFilename,
      durationSecs: job.durationSecs,
    };

    await updateProgress(
      job,
      isMp3TranscriptionInput(transcriptionInput)
        ? "MP3を文字起こししています…"
        : "音声を文字起こししています…",
      callbacks,
      discord,
      showDemoProgress,
    );

    const whisperTimeoutMs = whisperProcessingTimeoutMs(job.durationSecs);

    const transcription = await runJobStage(
      "whisper_transcription",
      async (signal) => {
        const startedAt = Date.now();

        let progressPending: Promise<void> | null = null;

        const progressTimer = showDemoProgress
          ? setInterval(() => {
              if (progressPending !== null) {
                return;
              }

              const elapsedSeconds = (Date.now() - startedAt) / 1000;

              const timeoutSeconds = whisperTimeoutMs / 1000;

              progressPending = updateProgress(
                job,
                `文字起こし処理中（経過 ${elapsedSeconds.toFixed(0)}秒 / タイムアウト ${timeoutSeconds.toFixed(0)}秒）…`,
                callbacks,
                discord,
                true,
              ).finally(() => {
                progressPending = null;
              });
            }, 30_000)
          : undefined;

        if (isMp3TranscriptionInput(transcriptionInput)) {
          await monitor?.stageProgress(job.id, "MP3原本を文字起こし中");
        }

        try {
          const service = new CloudflareWhisperTranscriptionService(
            env.AI,
            async ({ phase }) => {
              if (phase === "rebuild_started") {
                const detail =
                  "MP3直接decode失敗・フレームのみ再構成して再送中";

                await Promise.all([
                  updateProgress(
                    job,
                    `${detail}…`,
                    callbacks,
                    discord,
                    showDemoProgress,
                  ),
                  monitor?.stageProgress(job.id, detail),
                ]);
              }
            },
          );

          return await service.transcribe({
            ...transcriptionInput,
            signal,
          });
        } finally {
          if (progressTimer !== undefined) {
            clearInterval(progressTimer);
          }

          /*
           * ここも待ちすぎない。
           * progress update は本処理より重要度が低い。
           */
        }
      },
      whisperTimeoutMs,
    );

    transcriptionResult = transcription;

    if (!(await jobs.isActive(job.id))) {
      console.warn("audio_job_processing_stopped", {
        jobId: job.id,
        stage: "whisper_transcription",
      });

      return { outcome: "stopped" as const };
    }

    transcriptionText = transcription.text;

    needsTranscriptionCheckpoint = true;
  } else {
    console.info("audio_job_transcription_checkpoint_reused", {
      jobId: job.id,
      attempt,
    });

    await updateProgress(
      job,
      "保存済みの文字起こしを再利用して、メタデータ解析を再開しています…",
      callbacks,
      discord,
      showDemoProgress,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Empty transcription                                                    */
  /* ---------------------------------------------------------------------- */

  if (needsTranscriptionCheckpoint) {
    await runJobStage(
      "transcription_checkpoint",
      () => jobs.saveTranscription(job.id, transcriptionText),
      stageTimeouts.transcriptionCheckpoint,
    );

    console.info("audio_job_transcription_checkpoint_saved", {
      jobId: job.id,
      attempt,
    });

    if (showDemoProgress && transcriptionResult !== null) {
      const preparation =
        transcriptionResult.audioPreparation?.strategy === "mp3_rebuilt"
          ? `、MP3フレーム再構成で復旧（${transcriptionResult.audioPreparation.submittedBytes} bytes）`
          : "";

      await updateProgress(
        job,
        `文字起こしが完了しました（言語: ${transcriptionResult.language ?? "不明"}、セグメント: ${transcriptionResult.segments.length}件${preparation}）。`,
        callbacks,
        discord,
        true,
      );
    }
  }

  if (transcriptionText.trim() === "") {
    await jobs.updateStatus(job.id, "failed", "empty_transcription");

    await notify(job, emptyTranscriptionMessage, callbacks, discord);

    await jobs.clearEphemeral(job.id);

    return { outcome: "failed" as const };
  }

  /* ---------------------------------------------------------------------- */
  /* Checkpoint                                                             */
  /* ---------------------------------------------------------------------- */

  return {
    outcome: "ready" as const,
    audio,
    transcriptionText,
    transcriptionResult,
  };
}
