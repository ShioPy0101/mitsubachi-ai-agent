import { WorkersAiWhisperResponseSchema } from "./schemas";
import type { TranscriptionInput, TranscriptionResult, TranscriptionService } from "./service";
import { transcodeMp3ToMonoWavChunks, type Mp3WavChunk } from "../audio/silence-segmenter";

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

function normalizedContentType(contentType: string | null): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function isMp3TranscriptionInput(input: TranscriptionInput): boolean {
  const type = normalizedContentType(input.contentType);
  return ["audio/mpeg", "audio/mp3", "audio/x-mp3", "audio/x-mpeg", "audio/mpeg3", "audio/x-mpeg-3"].includes(type)
    || input.filename.toLowerCase().endsWith(".mp3");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isWorkersAiAudioDecodeError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const message = errorMessage(error).toLowerCase();
  return code === "3030" || message.includes("3030") || message.includes("failed to decode audio file");
}

export class WhisperAudioDecodeError extends Error {
  constructor(initialError: unknown, fallbackError: unknown) {
    super(
      "MP3の原本とWAV変換後の両方をWhisperがデコードできませんでした。"
      + ` original=${errorMessage(initialError)}; fallback=${errorMessage(fallbackError)}`,
    );
    this.name = "WhisperAudioDecodeError";
  }
}

export class WhisperMp3TranscodeError extends Error {
  constructor(error: unknown) {
    super(`MP3をWhisper互換WAVへ変換できませんでした: ${errorMessage(error)}`);
    this.name = "WhisperMp3TranscodeError";
  }
}

type Mp3ChunkTranscoder = (audio: ArrayBuffer) => AsyncIterable<Mp3WavChunk>;
type Mp3Progress = {
  phase: "fallback_started" | "chunk_completed";
  completedChunks: number;
  processedSeconds: number;
};

export class CloudflareWhisperTranscriptionService implements TranscriptionService {
  constructor(
    private readonly ai: WhisperAiRunner,
    private readonly transcodeMp3: Mp3ChunkTranscoder = transcodeMp3ToMonoWavChunks,
    private readonly onMp3Progress?: (progress: Mp3Progress) => Promise<void>,
  ) {}

  private async run(audio: ArrayBuffer): Promise<TranscriptionResult> {
    const output = await this.ai.run(whisperModel, {
      audio: encodeBase64(audio),
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

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    if (isMp3TranscriptionInput(input)) {
      let initialError: unknown;
      try {
        const result = await this.run(input.audio);
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
      console.warn("whisper_mp3_decode_fallback_started", {
        filename: input.filename,
        originalBytes: input.audio.byteLength,
        error: errorMessage(initialError),
      });
      await this.onMp3Progress?.({ phase: "fallback_started", completedChunks: 0, processedSeconds: 0 });
      const results: Array<{ result: TranscriptionResult; startSec: number }> = [];
      let submittedBytes = 0;
      let chunks: AsyncIterator<Mp3WavChunk>;
      try {
        chunks = this.transcodeMp3(input.audio)[Symbol.asyncIterator]();
      } catch (error) {
        throw new WhisperMp3TranscodeError(error);
      }
      while (true) {
        let next: IteratorResult<Mp3WavChunk>;
        try {
          next = await chunks.next();
        } catch (error) {
          throw new WhisperMp3TranscodeError(error);
        }
        if (next.done) break;
        const chunk = next.value;
        const result = await this.run(chunk.audio);
        results.push({ result, startSec: chunk.startSec });
        submittedBytes += chunk.audio.byteLength;
        await this.onMp3Progress?.({
          phase: "chunk_completed",
          completedChunks: results.length,
          processedSeconds: chunk.endSec,
        });
      }
      if (results.length === 0) throw new WhisperMp3TranscodeError(new Error("MP3 decoder produced no chunks"));
      console.info("whisper_mp3_chunked_transcription_completed", {
        filename: input.filename,
        originalBytes: input.audio.byteLength,
        chunkCount: results.length,
        submittedBytes,
      });
      return {
        language: results.map(({ result }) => result.language).find((language) => language !== null) ?? null,
        text: results.map(({ result }) => result.text.trim()).filter((text) => text !== "").join("\n"),
        segments: results.flatMap(({ result, startSec }) => result.segments.map((segment) => ({
          ...segment,
          startSec: segment.startSec + startSec,
          endSec: segment.endSec + startSec,
        }))),
        audioPreparation: {
          strategy: "mp3_streaming_wav_chunks",
          originalBytes: input.audio.byteLength,
          submittedBytes,
          initialDecodeError: errorMessage(initialError),
          chunkCount: results.length,
        },
      };
    }
    const result = await this.run(input.audio);
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
