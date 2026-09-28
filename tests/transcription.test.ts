import { describe, expect, it } from "vitest";
import {
  CloudflareWhisperTranscriptionService,
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

describe("Workers AI response adapter", () => {
  it("maps a validated response to the domain type", async () => {
    const ai = new FakeAi({
      transcription_info: { language: "ja" },
      text: "次は西和田です",
      segments: [{ start: 0.5, end: 2.5, text: "次は西和田です" }],
    });
    const service = new CloudflareWhisperTranscriptionService(ai);
    await expect(service.transcribe({
      audio: new ArrayBuffer(1), contentType: "audio/mpeg", filename: "audio.mp3",
    })).resolves.toEqual({
      language: "ja",
      text: "次は西和田です",
      segments: [{ startSec: 0.5, endSec: 2.5, text: "次は西和田です" }],
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
      audio: new ArrayBuffer(1), contentType: null, filename: "audio.mp3",
    })).rejects.toThrow();
  });
});
