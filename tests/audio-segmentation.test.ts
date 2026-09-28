import { describe, expect, it } from "vitest";
import { splitAudioOnSilence } from "../src/audio/silence-segmenter";

function monoWav(samples: Float32Array, sampleRate = 8_000): ArrayBuffer {
  const output = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(output);
  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, output.byteLength - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.round(sample * 0x7fff), true));
  return output;
}

describe("silence audio segmentation", () => {
  it("splits WAV audio at a sustained silent interval", async () => {
    const sampleRate = 8_000;
    const samples = new Float32Array(Math.round(sampleRate * 2.8));
    samples.fill(0.2, 0, sampleRate);
    samples.fill(0.2, Math.round(sampleRate * 1.8));

    const chunks = await splitAudioOnSilence(monoWav(samples), "audio/wav", "announcement.wav");

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.contentType).toBe("audio/wav");
    expect(chunks[0]?.startSec).toBe(0);
    expect(chunks[0]?.endSec).toBeCloseTo(1.15, 1);
    expect(chunks[1]?.startSec).toBeCloseTo(1.65, 1);
    expect(chunks[1]?.endSec).toBeCloseTo(2.8, 1);
    expect(new TextDecoder().decode(chunks[0]?.audio.slice(0, 4))).toBe("RIFF");
  });

  it("removes sustained silence at the beginning and end", async () => {
    const sampleRate = 8_000;
    const samples = new Float32Array(Math.round(sampleRate * 2.6));
    samples.fill(0.2, Math.round(sampleRate * 0.8), Math.round(sampleRate * 1.8));

    const chunks = await splitAudioOnSilence(monoWav(samples), "audio/wav", "announcement.wav");

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.startSec).toBeCloseTo(0.65, 1);
    expect(chunks[0]?.endSec).toBeCloseTo(1.95, 1);
    expect(chunks[0]?.audio.byteLength).toBeLessThan(monoWav(samples).byteLength);
  });

  it("keeps an unsupported format unchanged", async () => {
    const input = new Uint8Array([1, 2, 3]).buffer;
    const chunks = await splitAudioOnSilence(input, "audio/mp4", "announcement.m4a");
    expect(chunks).toEqual([{ audio: input, contentType: "audio/mp4", startSec: 0, endSec: 0 }]);
  });

  it("keeps malformed MP3 input unchanged", async () => {
    const input = new Uint8Array([1, 2, 3]).buffer;
    const chunks = await splitAudioOnSilence(input, "audio/mpeg", "announcement.mp3", 220);
    expect(chunks).toEqual([{ audio: input, contentType: "audio/mpeg", startSec: 0, endSec: 220 }]);
  });
});
