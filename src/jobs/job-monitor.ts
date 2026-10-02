import type {
  JobMonitorRecord,
  JobMonitorState,
} from "../db/job-monitor-repository";
import { JobMonitorRepository } from "../db/job-monitor-repository";
import type { DiscordMessageComponent } from "../discord/rest-client";
import { DiscordRestClient } from "../discord/rest-client";
import type { AudioJob } from "./types";

const stageLabels: Record<string, string> = {
  queue_start: "Queue処理開始",
  attachment_download: "音声ファイル取得",
  whisper_transcription: "Whisper文字起こし",
  transcription_checkpoint: "文字起こし中間保存",
  transcription_provenance: "保存済み文字起こし・segment情報の確認",
  gemini_analysis: "Gemini #1 放送構造解析",
  gemini_normalization: "Gemini #2 文字起こし補正",
  station_candidates_sequences: "駅・経路候補一括探索",
  clip_save: "解析結果保存",
  attachment_download_for_result: "結果用音声ファイル取得",
  result_notification: "Discord結果送信",
  ephemeral_cleanup: "一時データ削除",
  discord_callback_lookup: "Discord応答先確認",
  processing_timeout: "処理期限超過",
};

export function stageLabel(stage: string): string {
  if (stage.startsWith("station_candidates_sequence_")) {
    return `駅・経路候補探索 #${stage.slice("station_candidates_sequence_".length)}`;
  }
  return stageLabels[stage] ?? stage;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatJapanTime(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function stateHeading(state: JobMonitorState): string {
  switch (state) {
    case "cancel_requested":
      return "🟡 停止要求済み";
    case "stopped":
      return "⏹ ジョブ停止";
    case "completed":
      return "✅ ジョブ完了";
    case "failed":
      return "❌ ジョブ失敗";
    case "timed_out":
      return "⌛ ジョブタイムアウト";
    case "retrying":
      return "🔁 音声ジョブ再試行待ち";
    default:
      return "🔄 音声ジョブ実行中";
  }
}

function stateText(state: JobMonitorState): string {
  return {
    running: "実行中",
    retrying: "再試行中",
    cancel_requested: "停止要求済み",
    stopped: "stopped",
    completed: "completed",
    failed: "failed",
    timed_out: "timed_out",
  }[state];
}

export function formatJobMonitorMessage(record: JobMonitorRecord): string {
  const effectiveNow =
    record.completedAt === null ? Date.now() : Date.parse(record.completedAt);
  const elapsedSeconds = Math.max(
    0,
    (effectiveNow - Date.parse(record.startedAt)) / 1000,
  );
  const stageElapsedSeconds = Math.max(
    0,
    (effectiveNow - Date.parse(record.stageStartedAt)) / 1000,
  );
  const stageTimeoutSeconds =
    record.stageTimeoutAt === null
      ? null
      : Math.max(
          0,
          (Date.parse(record.stageTimeoutAt) -
            Date.parse(record.stageStartedAt)) /
            1000,
        );
  const stageTimeoutDisplay =
    stageTimeoutSeconds === null
      ? "設定なし"
      : `${stageTimeoutSeconds.toFixed(1)}秒${
          effectiveNow >= Date.parse(record.stageTimeoutAt!) &&
          record.completedAt === null
            ? "（超過・現在の外部処理終了待ち）"
            : ""
        }`;
  const lines = [
    stateHeading(record.state),
    "",
    `Job ID:\n\`${record.jobId}\``,
    "",
    `ユーザー:\n${record.userId === null ? "不明" : `<@${record.userId}>`}`,
    "",
    `ファイル:\n${record.filename}`,
    "",
    `サイズ:\n${formatBytes(record.sizeBytes)}`,
    "",
    `Queue attempt:\n${record.queueAttempt}`,
    "",
    `${record.state === "failed" ? "失敗フェーズ" : record.state === "stopped" ? "最後のフェーズ" : "現在のフェーズ"}:`,
    `\`${record.currentStage}\` — ${stageLabel(record.currentStage)}`,
    "",
    ...(record.stageDetail === null
      ? []
      : [`進行:\n${record.stageDetail}`, ""]),
    ...(record.observations === ""
      ? []
      : [`観測:\n\`\`\`text\n${record.observations}\n\`\`\``, ""]),
    `開始:\n${formatJapanTime(record.startedAt)}`,
    "",
    `フェーズ開始から:\n${stageElapsedSeconds.toFixed(1)}秒`,
    "",
    `現在フェーズのタイムアウト:\n${stageTimeoutDisplay}`,
    "",
    `状態:\n${stateText(record.state)}`,
  ];
  if (record.cancellationRequestedAt !== null) {
    lines.push(
      "",
      `停止要求:\n${formatJapanTime(record.cancellationRequestedAt)}`,
    );
    if (record.state === "cancel_requested") {
      lines.push(
        "",
        "現在のフェーズが終了するか、中断可能な処理であれば中断後に停止します。",
      );
    }
  }
  if (record.errorMessage !== null)
    lines.push(
      "",
      `エラー:\n\`\`\`text\n${record.errorMessage.slice(0, 900)}\n\`\`\``,
    );
  if (record.completedAt !== null)
    lines.push("", `処理時間:\n${elapsedSeconds.toFixed(1)}秒`);
  return lines.join("\n");
}

function stopComponents(
  jobId: string,
  disabled: boolean,
): DiscordMessageComponent[] {
  const customId = `admin_job_stop:${jobId}`;
  if (customId.length > 100)
    throw new Error("Job id is too long for a Discord component custom_id");
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 4,
          custom_id: customId,
          label: "停止",
          emoji: { name: "⏹" },
          disabled,
        },
      ],
    },
  ];
}

export class JobCancellationRequestedError extends Error {
  constructor(
    readonly jobId: string,
    readonly stage: string,
  ) {
    super(`Cancellation requested for job ${jobId} at ${stage}`);
    this.name = "JobCancellationRequestedError";
  }
}

export class JobMonitor {
  constructor(
    private readonly channelId: string | null,
    private readonly repository: JobMonitorRepository,
    private readonly discord: DiscordRestClient,
  ) {}

  get enabled(): boolean {
    return this.channelId !== null;
  }

  async start(job: AudioJob, queueAttempt: number): Promise<void> {
    if (this.channelId === null) return;
    const now = new Date().toISOString();
    let record = await this.repository.ensure({
      jobId: job.id,
      channelId: this.channelId,
      queueAttempt,
      userId: job.source.userId,
      filename: job.originalFilename,
      sizeBytes: job.sizeBytes,
      now,
    });
    if (record.messageId === null) {
      const result = await this.discord.createChannelMessage(
        this.channelId,
        formatJobMonitorMessage(record),
        stopComponents(job.id, false),
      );
      if (!result.ok)
        throw new Error(
          `Job monitor message creation failed (${result.status}): ${result.responseBody}`,
        );
      await this.repository.setMessageId(
        job.id,
        result.messageId,
        new Date().toISOString(),
      );
      record = { ...record, messageId: result.messageId };
    } else {
      await this.render(record);
    }
  }

  async assertNotCancelled(jobId: string, stage: string): Promise<void> {
    if (
      this.channelId !== null &&
      (await this.repository.isCancellationRequested(jobId))
    ) {
      throw new JobCancellationRequestedError(jobId, stage);
    }
  }

  async stageStarted(
    jobId: string,
    stage: string,
    timeoutMs?: number,
  ): Promise<void> {
    if (this.channelId === null) return;
    const now = new Date();
    const timeoutAt =
      timeoutMs === undefined
        ? null
        : new Date(now.getTime() + timeoutMs).toISOString();
    await this.repository.stageStarted(
      jobId,
      stage,
      now.toISOString(),
      timeoutAt,
    );
    await this.renderById(jobId);
  }

  async requestCancellation(jobId: string): Promise<JobMonitorRecord | null> {
    if (this.channelId === null) return null;
    const record = await this.repository.requestCancellation(
      jobId,
      new Date().toISOString(),
    );
    if (record !== null) await this.render(record);
    return record;
  }

  async stageProgress(jobId: string, detail: string): Promise<void> {
    if (this.channelId === null) return;
    await this.repository.updateStageDetail(
      jobId,
      detail,
      new Date().toISOString(),
    );
    await this.renderById(jobId);
  }

  async observation(jobId: string, detail: string): Promise<void> {
    if (this.channelId === null) return;
    await this.repository.appendObservation(
      jobId,
      detail,
      new Date().toISOString(),
    );
    await this.renderById(jobId);
  }

  async transition(
    jobId: string,
    state: JobMonitorState,
    stage?: string,
    error?: unknown,
  ): Promise<void> {
    if (this.channelId === null) return;
    const errorMessage =
      error === undefined
        ? null
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
    const record = await this.repository.transition(jobId, state, {
      now: new Date().toISOString(),
      ...(stage === undefined ? {} : { stage }),
      errorMessage,
    });
    if (record !== null) await this.render(record);
  }

  async refresh(jobId: string): Promise<void> {
    if (this.channelId === null) return;
    await this.renderById(jobId);
  }

  private async renderById(jobId: string): Promise<void> {
    const record = await this.repository.find(jobId);
    if (record !== null) await this.render(record);
  }

  private async render(record: JobMonitorRecord): Promise<void> {
    if (record.messageId === null) return;
    const disabled = ["stopped", "completed", "failed", "timed_out"].includes(
      record.state,
    );
    try {
      const result = await this.discord.editChannelMessage(
        record.channelId,
        record.messageId,
        formatJobMonitorMessage(record),
        stopComponents(record.jobId, disabled),
      );
      if (!result.ok) {
        console.error("audio_job_monitor_message_edit_failed", {
          jobId: record.jobId,
          status: result.status,
          responseBody: result.responseBody,
        });
      }
    } catch (error) {
      console.error("audio_job_monitor_message_edit_failed", {
        jobId: record.jobId,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function adminJobsChannelId(env: Env): string | null {
  const value = env.ADMIN_JOBS_CHANNEL_ID?.trim();
  return value ? value : null;
}

export function createJobMonitor(
  env: Env,
  discord?: DiscordRestClient,
): JobMonitor {
  return new JobMonitor(
    adminJobsChannelId(env),
    new JobMonitorRepository(env.DB),
    discord ??
      new DiscordRestClient(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID),
  );
}
