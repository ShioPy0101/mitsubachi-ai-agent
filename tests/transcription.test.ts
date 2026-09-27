import { describe, expect, it } from "vitest";
import {
  CloudflareWhisperTranscriptionService,
  combineTranscriptionPasses,
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
    const service = new CloudflareWhisperTranscriptionService(ai, "ja");
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
      language: "ja",
      vad_filter: true,
    }]);
  });

  it("combines independent language passes for metadata normalization", () => {
    expect(combineTranscriptionPasses([
      { language: "ja", text: " まもなく5番線から発車します。 " },
      { language: "en", text: "The train on platform 5 will depart shortly." },
    ])).toBe("[ja]\nまもなく5番線から発車します。\n\n[en]\nThe train on platform 5 will depart shortly.");
  });

  it("rejects an invalid provider response", async () => {
    const service = new CloudflareWhisperTranscriptionService(new FakeAi({ text: 42 }));
    await expect(service.transcribe({
      audio: new ArrayBuffer(1), contentType: null, filename: "audio.mp3",
    })).rejects.toThrow();
  });
});
