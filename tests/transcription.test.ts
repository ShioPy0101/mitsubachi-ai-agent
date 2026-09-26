import { describe, expect, it } from "vitest";
import { CloudflareWhisperTranscriptionService, type WhisperAiRunner } from "../src/transcription/workers-ai";

class FakeAi implements WhisperAiRunner {
  constructor(private readonly response: unknown) {}
  async run(
    _model: "@cf/openai/whisper-large-v3-turbo",
    _input: Ai_Cf_Openai_Whisper_Large_V3_Turbo_Input,
  ): Promise<unknown> {
    return this.response;
  }
}

describe("Workers AI response adapter", () => {
  it("maps a validated response to the domain type", async () => {
    const service = new CloudflareWhisperTranscriptionService(new FakeAi({
      transcription_info: { language: "ja" },
      text: "次は西和田です",
      segments: [{ start: 0.5, end: 2.5, text: "次は西和田です" }],
    }));
    await expect(service.transcribe({
      audio: new ArrayBuffer(1), contentType: "audio/mpeg", filename: "audio.mp3",
    })).resolves.toEqual({
      language: "ja",
      text: "次は西和田です",
      segments: [{ startSec: 0.5, endSec: 2.5, text: "次は西和田です" }],
    });
  });

  it("rejects an invalid provider response", async () => {
    const service = new CloudflareWhisperTranscriptionService(new FakeAi({ text: 42 }));
    await expect(service.transcribe({
      audio: new ArrayBuffer(1), contentType: null, filename: "audio.mp3",
    })).rejects.toThrow();
  });
});
