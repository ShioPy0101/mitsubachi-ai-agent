import { WorkersAiWhisperResponseSchema } from "./schemas";
import type { TranscriptionInput, TranscriptionResult, TranscriptionService } from "./service";

export const railwayAnnouncementPrompt = [
  "日本の鉄道駅構内放送。駅名、路線名、列車名、時刻、番線。",
  "日本語、英語、中国語、韓国語など、音声で話されたすべての言語を翻訳・要約・省略せず、最後までそのまま文字起こしする。",
  "Transcribe every spoken language verbatim and completely. Do not translate, summarize, or omit English sentences.",
  "Japanese railway station announcement. Station, line, train, time, platform, car, reserved seat, non-reserved seat, and destination.",
  "English railway vocabulary: the train arriving at the platform, limited express, bound for, cars, reserved seats, non-reserved seats, on schedule, please stand behind the yellow tactile paving.",
].join(" ");

export const whisperModel = "@cf/openai/whisper-large-v3-turbo" as const;
export const whisperSettings = {
  task: "transcribe",
  vad_filter: true,
  beam_size: 8,
  initial_prompt: railwayAnnouncementPrompt,
} as const;

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
    const output = await this.ai.run(whisperModel, {
      audio: encodeBase64(input.audio),
      ...whisperSettings,
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
