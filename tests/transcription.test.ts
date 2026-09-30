import { describe, expect, it } from "vitest";
import {
  CloudflareWhisperTranscriptionService,
  isWorkersAiAudioDecodeError,
  type WhisperAiRunner,
} from "../src/transcription/workers-ai";

class FakeAi implements WhisperAiRunner {
  readonly inputs: Ai_Cf_Openai_Whisper_Large_V3_Turbo_Input[] = [];
  constructor(private readonly response: unknown) {}
  async run(
    _model: "@cf/openai/whisper-large-v3-turbo",
    input: Ai_Cf_Openai_Whisper_Large_V3_Turbo_Input,
  ): Promise<unknown> {
    this.inputs.push(input);
    return this.response;
  }
}

function wavWithSilence(sampleRate = 8_000): ArrayBuffer {
  const samples = new Float32Array(Math.round(sampleRate * 2.8));
  samples.fill(0.2, 0, sampleRate);
  samples.fill(0.2, Math.round(sampleRate * 1.8));
  const output = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(output);
  const ascii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, output.byteLength - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.round(sample * 0x7fff), true));
  return output;
}

describe("Workers AI response adapter", () => {
  it("maps a validated response to the domain type", async () => {
    const ai = new FakeAi({
      transcription_info: { language: "ja" },
      text: "次は西和田です",
      segments: [{ start: 0.5, end: 2.5, text: "次は西和田です" }],
    });
    const service = new CloudflareWhisperTranscriptionService(ai);
    await expect(service.transcribe({
      audio: new ArrayBuffer(1), contentType: null, filename: "audio.bin",
    })).resolves.toEqual({
      language: "ja",
      text: "次は西和田です",
      segments: [{ startSec: 0.5, endSec: 2.5, text: "次は西和田です" }],
      audioPreparation: {
        strategy: "original",
        originalBytes: 1,
        submittedBytes: 1,
        initialDecodeError: null,
      },
    });
    expect(ai.inputs).toEqual([{
      audio: "AA==",
      task: "transcribe",
      vad_filter: true,
      beam_size: 8,
      initial_prompt: "日本の鉄道駅構内放送。駅名、路線名、列車名、時刻、番線。 日本語、英語、中国語、韓国語など、音声で話されたすべての言語を翻訳・要約・省略せず、最後までそのまま文字起こしする。 Transcribe every spoken language verbatim and completely. Do not translate, summarize, or omit English sentences. Japanese railway station announcement. Station, line, train, time, platform, car, reserved seat, non-reserved seat, and destination. English railway vocabulary: the train arriving at the platform, limited express, bound for, cars, reserved seats, non-reserved seats, on schedule, please stand behind the yellow tactile paving.",
    }]);
  });

  it("rejects an invalid provider response", async () => {
    const service = new CloudflareWhisperTranscriptionService(new FakeAi({ text: 42 }));
    await expect(service.transcribe({
      audio: new ArrayBuffer(1), contentType: null, filename: "audio.bin",
    })).rejects.toThrow();
  });

  it("sends the complete audio in one request", async () => {
    const ai = new FakeAi({
      transcription_info: { language: "ja" },
      text: "announcement",
      segments: [{ start: 0, end: 1, text: "announcement" }],
    });
    const result = await new CloudflareWhisperTranscriptionService(ai).transcribe({
      audio: wavWithSilence(), contentType: "audio/wav", filename: "announcement.wav",
    });

    expect(ai.inputs).toHaveLength(1);
    expect(result.text).toBe("announcement");
    expect(result.segments).toHaveLength(1);
  });

  it("transcribes MP3 as bounded WAV chunks without retaining a full PCM file", async () => {
    const inputs: Ai_Cf_Openai_Whisper_Large_V3_Turbo_Input[] = [];
    const decodeError = Object.assign(new Error("3030: Failed to decode audio file"), { code: 3030 });
    const ai: WhisperAiRunner = {
      run: async (_model, input) => {
        inputs.push(input);
        if (inputs.length === 1) throw decodeError;
        const chunkNumber = inputs.length - 1;
        return {
          transcription_info: { language: "ja" },
          text: `チャンク${chunkNumber}`,
          segments: [{ start: 0, end: 1, text: `チャンク${chunkNumber}` }],
        };
      },
    };
    const transcode = async function* () {
      yield { audio: new Uint8Array([82, 73, 70, 70]).buffer, index: 0, startSec: 0, endSec: 45 };
      yield { audio: new Uint8Array([87, 65, 86, 69]).buffer, index: 1, startSec: 45, endSec: 70 };
    };
    const progress: number[] = [];

    const result = await new CloudflareWhisperTranscriptionService(
      ai,
      transcode,
      async ({ phase, completedChunks }) => {
        if (phase === "chunk_completed") progress.push(completedChunks);
      },
    ).transcribe({
      audio: new Uint8Array([1, 2, 3]).buffer,
      contentType: "audio/mpeg",
      filename: "problem.mp3",
    });

    expect(inputs.map(({ audio }) => audio)).toEqual(["AQID", "UklGRg==", "V0FWRQ=="]);
    expect(progress).toEqual([1, 2]);
    expect(result).toMatchObject({
      text: "チャンク1\nチャンク2",
      segments: [
        { startSec: 0, endSec: 1, text: "チャンク1" },
        { startSec: 45, endSec: 46, text: "チャンク2" },
      ],
      audioPreparation: {
        strategy: "mp3_streaming_wav_chunks",
        originalBytes: 3,
        submittedBytes: 8,
        initialDecodeError: "3030: Failed to decode audio file",
        chunkCount: 2,
      },
    });
  });

  it("submits a compatible MP3 directly without invoking the local decoder", async () => {
    const ai = new FakeAi({ transcription_info: { language: "ja" }, text: "直接成功", segments: [] });
    let transcodeCalls = 0;
    const service = new CloudflareWhisperTranscriptionService(ai, async function* () {
      transcodeCalls += 1;
      yield { audio: new ArrayBuffer(1), index: 0, startSec: 0, endSec: 1 };
    });

    const result = await service.transcribe({
      audio: new Uint8Array([1, 2, 3]).buffer,
      contentType: "audio/mpeg",
      filename: "compatible.mp3",
    });

    expect(ai.inputs).toHaveLength(1);
    expect(transcodeCalls).toBe(0);
    expect(result.audioPreparation).toMatchObject({ strategy: "original", submittedBytes: 3 });
  });

  it("does not retry decode errors for non-MP3 input", async () => {
    const decodeError = new Error("3030: Failed to decode audio file");
    let transcodeCalls = 0;
    const ai: WhisperAiRunner = { run: async () => { throw decodeError; } };
    const service = new CloudflareWhisperTranscriptionService(ai, async function* () {
      transcodeCalls += 1;
      yield { audio: new ArrayBuffer(1), index: 0, startSec: 0, endSec: 1 };
    });

    await expect(service.transcribe({
      audio: new ArrayBuffer(1), contentType: "audio/wav", filename: "audio.wav",
    })).rejects.toBe(decodeError);
    expect(transcodeCalls).toBe(0);
    expect(isWorkersAiAudioDecodeError(decodeError)).toBe(true);
  });
});
