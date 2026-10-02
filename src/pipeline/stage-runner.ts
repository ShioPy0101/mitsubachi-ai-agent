import {
  JobCancellationRequestedError,
  type JobMonitor,
} from "../jobs/job-monitor";
import { AudioJobProcessingTimeoutError } from "../jobs/processing-timeout";
const jobMonitorRefreshIntervalMs = 30_000;
const errorStages = new WeakMap<object, string>();

export function errorDetails(error: unknown): {
  errorName: string;
  errorMessage: string;
} {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: String(error),
  };
}

export function errorStage(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null) {
    return fallback;
  }

  return errorStages.get(error) ?? fallback;
}

export function tagErrorStage(error: unknown, stage: string): void {
  if (typeof error === "object" && error !== null) {
    errorStages.set(error, stage);
  }
}

/* -------------------------------------------------------------------------- */
/* Stage runner                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 重要:
 *
 * AbortController.abort() だけでは、operation が AbortSignal を
 * 無視している場合 Promise 自体は終了しない。
 *
 * そのため、
 *
 *   operationPromise
 *      vs
 *   abortPromise
 *
 * を Promise.race() する。
 *
 * これによって外部処理が AbortSignal 非対応でも、
 * 呼び出し側は timeout / cancel 時点で処理を抜けることができる。
 *
 * 注意:
 * Promise.race から外れた underlying operation を物理的に停止できるとは
 * 限らない。可能なAPIについては signal を実処理まで渡す。
 */
export async function runStage<T>(
  jobId: string,
  stage: string,
  operation: (signal: AbortSignal) => Promise<T>,
  monitor?: JobMonitor,
  timeoutMs?: number,
): Promise<T> {
  await monitor?.assertNotCancelled(jobId, stage);

  await monitor?.stageStarted(jobId, stage, timeoutMs);

  await monitor?.assertNotCancelled(jobId, stage);

  console.info("audio_job_stage_started", {
    jobId,
    stage,
    timeoutMs: timeoutMs ?? null,
  });

  const operationStartedAt = Date.now();

  const controller = new AbortController();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  let refreshPending: Promise<void> | null = null;

  /*
   * AbortSignal を処理本体が無視していても
   * Promise.race を終了させるための Promise。
   */
  const abortPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        reject(
          controller.signal.reason ?? new Error(`stage aborted: ${stage}`),
        );
      },
      {
        once: true,
      },
    );
  });

  void abortPromise.catch(() => undefined);

  if (timeoutMs !== undefined) {
    timeoutId = setTimeout(() => {
      if (controller.signal.aborted) {
        return;
      }

      controller.abort(new AudioJobProcessingTimeoutError(timeoutMs));
    }, timeoutMs);
  }

  const refreshTimer = monitor?.enabled
    ? setInterval(() => {
        if (refreshPending !== null) {
          return;
        }

        refreshPending = Promise.all([
          monitor.refresh(jobId),
          monitor.assertNotCancelled(jobId, stage),
        ])
          .then(() => undefined)
          .catch((error: unknown) => {
            if (error instanceof JobCancellationRequestedError) {
              if (!controller.signal.aborted) {
                controller.abort(error);
              }

              return;
            }

            console.error("audio_job_monitor_refresh_failed", {
              jobId,
              stage,
              ...errorDetails(error),
            });
          })
          .finally(() => {
            refreshPending = null;
          });
      }, jobMonitorRefreshIntervalMs)
    : undefined;

  try {
    const operationPromise = Promise.resolve().then(() =>
      operation(controller.signal),
    );

    // Workers AI must settle after abort; never abandon the provider operation.
    const result =
      stage === "whisper_transcription"
        ? await operationPromise
        : await Promise.race([operationPromise, abortPromise]);

    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new Error(`stage aborted: ${stage}`);
    }

    /*
     * Event loop が長時間ブロックされたケースなど、
     * setTimeout が時間通り実行されなかった場合の保険。
     */
    if (
      timeoutMs !== undefined &&
      Date.now() - operationStartedAt >= timeoutMs
    ) {
      throw new AudioJobProcessingTimeoutError(timeoutMs);
    }

    await monitor?.assertNotCancelled(jobId, stage);

    console.info("audio_job_stage_completed", {
      jobId,
      stage,
      elapsedMs: Date.now() - operationStartedAt,
    });

    return result;
  } catch (error) {
    const stageError = controller.signal.aborted
      ? (controller.signal.reason ?? error)
      : error;

    tagErrorStage(stageError, stage);

    console.error("audio_job_stage_failed", {
      jobId,
      stage,
      elapsedMs: Date.now() - operationStartedAt,
      ...errorDetails(stageError),
    });

    throw stageError;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer);
    }

    /*
     * refreshPending をここで await すると、
     * monitor backend が固まったときに
     * stage timeout 後も finally で待たされる。
     *
     * refreshPending 側は自身で catch 済みなので、
     * stage終了時には待たない。
     */
  }
}
