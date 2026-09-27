import { WorkersAiWhisperResponseSchema } from "./schemas";
import type { TranscriptionInput, TranscriptionResult, TranscriptionService } from "./service";

export interface WhisperAiRunner {
  run(
    model: "@cf/openai/whisper-large-v3-turbo",
    input: Ai_Cf_Openai_Whisper_Large_V3_Turbo_Input,
  ): Promise<unknown>;
}

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export class CloudflareWhisperTranscriptionService implements TranscriptionService {
  constructor(private readonly ai: WhisperAiRunner) {}

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const output = await this.ai.run("@cf/openai/whisper-large-v3-turbo", {
      audio: encodeBase64(input.audio),
      task: "transcribe",
      language: "ja",
      vad_filter: true,
    });
    const parsed = WorkersAiWhisperResponseSchema.parse(output);
    return {
      language: parsed.transcription_info?.language ?? null,
      text: parsed.text,
      segments: (parsed.segments ?? []).map((segment) => ({
        startSec: segment.start,
        endSec: segment.end,
        text: segment.text,
      })),
    };
  }
}
