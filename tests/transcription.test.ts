import { describe, expect, it } from "vitest";
import {
  CloudflareWhisperTranscriptionService,
  TranscriptionTimeoutError,
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
    });
    expect(ai.inputs).toEqual([{
      audio: "AA==",
      task: "transcribe",
      vad_filter: false,
      beam_size: 8,
      condition_on_previous_text: false,
      no_speech_threshold: 0.8,
      initial_prompt: "日本の公共交通機関の案内放送。鉄道、地下鉄、路面電車、路線バス、高速バス、船舶、航空機。駅名、停留所名、路線名、便名、時刻、乗り場。 日本語、英語、中国語、韓国語など、音声で話されたすべての言語を翻訳・要約・省略せず、最後までそのまま文字起こしする。 Transcribe every spoken language verbatim and completely. Do not translate, summarize, or omit English sentences. Japanese public transit announcement. Station, bus stop, line, train, bus, flight, ferry, time, platform, gate, and destination. English transit vocabulary: arriving, departing, bound for, platform, bus stop, boarding gate, transfer, on schedule, delayed, and cancelled.",
    }]);
  });

  it("rejects an invalid provider response", async () => {
    const service = new CloudflareWhisperTranscriptionService(new FakeAi({ text: 42 }));
    await expect(service.transcribe({
      audio: new ArrayBuffer(1), contentType: null, filename: "audio.bin",
    })).rejects.toThrow();
  });

  it("transcribes silence-delimited chunks independently and rejoins them", async () => {
    const ai = new FakeAi({
      transcription_info: { language: "ja" },
      text: "announcement",
      segments: [{ start: 0, end: 1, text: "announcement" }],
    });
    const result = await new CloudflareWhisperTranscriptionService(ai).transcribe({
      audio: wavWithSilence(), contentType: "audio/wav", filename: "announcement.wav",
    });

    expect(ai.inputs).toHaveLength(2);
    expect(result.text).toBe("announcement\nannouncement");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[1]?.startSec).toBeCloseTo(1.25, 1);
  });

  it("times out when Workers AI does not respond", async () => {
    const ai: WhisperAiRunner = {
      run: async (): Promise<never> => new Promise(() => undefined),
    };
    const service = new CloudflareWhisperTranscriptionService(ai, 5);

    await expect(service.transcribe({
      audio: new ArrayBuffer(1), contentType: null, filename: "audio.bin",
    })).rejects.toEqual(new TranscriptionTimeoutError(5));
  });
});
