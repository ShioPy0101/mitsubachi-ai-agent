import { AttachmentUnavailableError } from "../discord/rest-client";
import {
  AudioJobProcessingTimeoutError,
  JobDeadlineExceededError,
} from "../jobs/processing-timeout";
import {
  GeminiApiError,
  GeminiRequestTimeoutError,
  isRetryableGeminiError,
} from "../metadata/gemini";
import { WhisperAudioDecodeError } from "../transcription/workers-ai";
export type FailureCode =
  | "cancelled"
  | "empty_transcription"
  | "non_transit_content"
  | "content_policy_blocked"
  | "attachment_unavailable"
  | "audio_decode_failed"
  | "job_deadline_exceeded"
  | "stage_timeout"
  | "gemini_transport_failed"
  | "gemini_invalid_response"
  | "station_resolution_failed"
  | "database_failed"
  | "processing_failed";
export type RetryPolicy = "never" | "retry" | "limited";
export function classifyFailure(
  error: unknown,
  stage: string,
): { failureCode: FailureCode; retryPolicy: RetryPolicy } {
  if (error instanceof AttachmentUnavailableError)
    return { failureCode: "attachment_unavailable", retryPolicy: "never" };
  if (error instanceof WhisperAudioDecodeError)
    return { failureCode: "audio_decode_failed", retryPolicy: "never" };
  if (error instanceof JobDeadlineExceededError)
    return { failureCode: "job_deadline_exceeded", retryPolicy: "never" };
  if (error instanceof AudioJobProcessingTimeoutError)
    return { failureCode: "stage_timeout", retryPolicy: "never" };
  if (
    error instanceof GeminiApiError ||
    error instanceof GeminiRequestTimeoutError ||
    (stage.startsWith("gemini_") && isRetryableGeminiError(error))
  )
    return {
      failureCode: "gemini_transport_failed",
      retryPolicy: isRetryableGeminiError(error) ? "retry" : "never",
    };
  if (
    /D1|SQLITE|database/i.test(
      error instanceof Error ? error.message : String(error),
    )
  )
    return { failureCode: "database_failed", retryPolicy: "retry" };
  if (stage.startsWith("gemini_"))
    return { failureCode: "gemini_invalid_response", retryPolicy: "limited" };
  if (stage.startsWith("station_"))
    return { failureCode: "station_resolution_failed", retryPolicy: "retry" };
  return { failureCode: "processing_failed", retryPolicy: "limited" };
}
