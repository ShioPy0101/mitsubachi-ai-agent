import { WorkersAiWhisperResponseSchema } from "./schemas";
import type { TranscriptionInput, TranscriptionResult, TranscriptionService } from "./service";
import { rebuildMp3FromFrames } from "../audio/silence-segmenter";

export const railwayAnnouncementPrompt = [
  "日本の鉄道駅構内放送。駅名、路線名、列車名、時刻、番線、連続して読み上げられる停車駅",
  "Japanese railway station announcement. Station, line, train, time, and platform.",
  "日本語に続いて英語、中国語、韓国語などの案内が含まれる場合があります。",
].join(" ");

export const whisperModel = "@cf/openai/whisper-large-v3-turbo" as const;
export const whisperSettings = {
  task: "transcribe",
  vad_filter: true,
  initial_prompt: railwayAnnouncementPrompt,
} as const;

export interface WhisperAiRunner {
  run(model: "@cf/openai/whisper-large-v3-turbo", input: Ai_Cf_Openai_Whisper_Large_V3_Turbo_Input, options?: { signal?: AbortSignal }): Promise<unknown>;
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

function normalizedContentType(contentType: string | null): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function isMp3TranscriptionInput(input: TranscriptionInput): boolean {
  const type = normalizedContentType(input.contentType);
  return (
    ["audio/mpeg", "audio/mp3", "audio/x-mp3", "audio/x-mpeg", "audio/mpeg3", "audio/x-mpeg-3"].includes(type) || input.filename.toLowerCase().endsWith(".mp3")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isWorkersAiAudioDecodeError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = errorMessage(error).toLowerCase();
  return code === "3030" || message.includes("3030") || message.includes("failed to decode audio file");
}

export class WhisperAudioDecodeError extends Error {
  constructor(initialError: unknown, rebuiltError: unknown) {
    super(
      "MP3の原本とフレーム再構成後の両方をWhisperがデコードできませんでした。" +
        ` original=${errorMessage(initialError)}; rebuilt=${errorMessage(rebuiltError)}`,
    );
    this.name = "WhisperAudioDecodeError";
  }
}

type Mp3Rebuilder = (audio: ArrayBuffer) => ArrayBuffer;
type Mp3Progress = {
  phase: "rebuild_started";
};

export class CloudflareWhisperTranscriptionService implements TranscriptionService {
  constructor(
    private readonly ai: WhisperAiRunner,
    private readonly onMp3Progress?: (progress: Mp3Progress) => Promise<void>,
    private readonly rebuildMp3: Mp3Rebuilder = rebuildMp3FromFrames,
  ) {}

  private async run(audio: ArrayBuffer, signal?: AbortSignal): Promise<TranscriptionResult> {
    const output = await this.ai.run(
      whisperModel,
      {
        audio: encodeBase64(audio),
        ...whisperSettings,
      },
      { ...(signal === undefined ? {} : { signal }) },
    );
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

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    if (isMp3TranscriptionInput(input)) {
      let initialError: unknown;
      try {
        const result = await this.run(input.audio, input.signal);
        return {
          ...result,
          audioPreparation: {
            strategy: "original",
            originalBytes: input.audio.byteLength,
            submittedBytes: input.audio.byteLength,
            initialDecodeError: null,
          },
        };
      } catch (error) {
        if (!isWorkersAiAudioDecodeError(error)) throw error;
        initialError = error;
      }
      console.warn("whisper_mp3_rebuild_started", {
        filename: input.filename,
        originalBytes: input.audio.byteLength,
        error: errorMessage(initialError),
      });
      await this.onMp3Progress?.({ phase: "rebuild_started" });
      let rebuiltError: unknown;
      let rebuiltAudio: ArrayBuffer | null = null;
      try {
        rebuiltAudio = this.rebuildMp3(input.audio);
      } catch (error) {
        rebuiltError = error;
      }
      if (rebuiltAudio !== null) {
        try {
          const result = await this.run(rebuiltAudio, input.signal);
          console.info("whisper_mp3_rebuilt_transcription_completed", {
            filename: input.filename,
            originalBytes: input.audio.byteLength,
            rebuiltBytes: rebuiltAudio.byteLength,
          });
          return {
            ...result,
            audioPreparation: {
              strategy: "mp3_rebuilt",
              originalBytes: input.audio.byteLength,
              submittedBytes: rebuiltAudio.byteLength,
              initialDecodeError: errorMessage(initialError),
              rebuiltDecodeError: null,
            },
          };
        } catch (error) {
          if (!isWorkersAiAudioDecodeError(error)) throw error;
          rebuiltError = error;
        }
      }
      console.warn("whisper_mp3_rebuilt_decode_failed", {
        filename: input.filename,
        error: errorMessage(rebuiltError),
      });
      throw new WhisperAudioDecodeError(initialError, rebuiltError);
    }
    const result = await this.run(input.audio, input.signal);
    return {
      ...result,
      audioPreparation: {
        strategy: "original",
        originalBytes: input.audio.byteLength,
        submittedBytes: input.audio.byteLength,
        initialDecodeError: null,
      },
    };
  }
}
