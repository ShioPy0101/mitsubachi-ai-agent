import { WorkersAiWhisperResponseSchema } from "./schemas";
import type { TranscriptionInput, TranscriptionResult, TranscriptionService } from "./service";
import { splitAudioOnSilence, type AudioChunk } from "../audio/silence-segmenter";

const transitAnnouncementPrompt = [
  "日本の公共交通機関の案内放送。鉄道、地下鉄、路面電車、路線バス、高速バス、船舶、航空機。駅名、停留所名、路線名、便名、時刻、乗り場。",
  "日本語、英語、中国語、韓国語など、音声で話されたすべての言語を翻訳・要約・省略せず、最後までそのまま文字起こしする。",
  "Transcribe every spoken language verbatim and completely. Do not translate, summarize, or omit English sentences.",
  "Japanese public transit announcement. Station, bus stop, line, train, bus, flight, ferry, time, platform, gate, and destination.",
  "English transit vocabulary: arriving, departing, bound for, platform, bus stop, boarding gate, transfer, on schedule, delayed, and cancelled.",
].join(" ");

const defaultTranscriptionTimeoutMs = 120_000;

export class TranscriptionTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Whisper transcription timed out after ${timeoutMs}ms`);
    this.name = "TranscriptionTimeoutError";
  }
}

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
  constructor(
    private readonly ai: WhisperAiRunner,
    private readonly timeoutMs = defaultTranscriptionTimeoutMs,
  ) {}

  private async transcribeChunk(chunk: AudioChunk): Promise<TranscriptionResult> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new TranscriptionTimeoutError(this.timeoutMs)), this.timeoutMs);
    });
    let output: unknown;
    try {
      output = await Promise.race([
        this.ai.run("@cf/openai/whisper-large-v3-turbo", {
          audio: encodeBase64(chunk.audio),
          task: "transcribe",
          vad_filter: false,
          beam_size: 8,
          condition_on_previous_text: false,
          no_speech_threshold: 0.8,
          initial_prompt: transitAnnouncementPrompt,
        }),
        timeout,
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    const parsed = WorkersAiWhisperResponseSchema.parse(output);
    return {
      language: parsed.transcription_info?.language ?? null,
      text: parsed.text,
      segments: (parsed.segments ?? []).map((segment) => ({
        startSec: segment.start + chunk.startSec,
        endSec: segment.end + chunk.startSec,
        text: segment.text,
      })),
    };
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const chunks = await splitAudioOnSilence(input.audio, input.contentType, input.filename);
    const results = await Promise.all(chunks.map((chunk) => this.transcribeChunk(chunk)));
    return {
      language: results.map((result) => result.language).find((language) => language !== null) ?? null,
      text: results.map((result) => result.text.trim()).filter((text) => text !== "").join("\n"),
      segments: results.flatMap((result) => result.segments),
    };
  }
}
