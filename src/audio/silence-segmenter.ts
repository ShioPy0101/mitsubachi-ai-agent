import { MPEGDecoder } from "mpg123-decoder";

export type AudioChunk = {
  audio: ArrayBuffer;
  contentType: string | null;
  startSec: number;
  endSec: number;
};

type DecodedAudio = {
  channels: Float32Array[];
  sampleRate: number;
};

const frameDurationSec = 0.02;
const minimumSilenceSec = 0.6;
const minimumChunkSec = 1;
const edgePaddingSec = 0.15;
const maximumChunks = 10;

function extensionOf(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function normalizedContentType(contentType: string | null): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isWav(contentType: string | null, filename: string): boolean {
  const type = normalizedContentType(contentType);
  return type === "audio/wav" || type === "audio/x-wav" || extensionOf(filename) === "wav";
}

function isMp3(contentType: string | null, filename: string): boolean {
  const type = normalizedContentType(contentType);
  return ["audio/mpeg", "audio/mp3", "audio/x-mp3", "audio/x-mpeg", "audio/mpeg3", "audio/x-mpeg-3"].includes(type)
    || extensionOf(filename) === "mp3";
}

function ascii(view: DataView, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(view.getUint8(offset + index));
  return value;
}

function decodeWav(audio: ArrayBuffer): DecodedAudio {
  const view = new DataView(audio);
  if (view.byteLength < 44 || ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") {
    throw new Error("Unsupported WAV container");
  }

  let format: { tag: number; channels: number; sampleRate: number; bitsPerSample: number; blockAlign: number } | null = null;
  let dataOffset = -1;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const id = ascii(view, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + length > view.byteLength) throw new Error("Invalid WAV chunk length");
    if (id === "fmt " && length >= 16) {
      format = {
        tag: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      dataOffset = body;
      dataLength = length;
    }
    offset = body + length + (length % 2);
  }
  if (format === null || dataOffset < 0 || format.channels < 1 || format.sampleRate < 1 || format.blockAlign < 1) {
    throw new Error("Incomplete WAV file");
  }
  if (format.tag !== 1 && format.tag !== 3) throw new Error(`Unsupported WAV format ${format.tag}`);
  if (format.tag === 3 && format.bitsPerSample !== 32) throw new Error("Unsupported floating-point WAV depth");
  if (format.tag === 1 && ![8, 16, 24, 32].includes(format.bitsPerSample)) throw new Error("Unsupported PCM WAV depth");

  const sampleCount = Math.floor(dataLength / format.blockAlign);
  const bytesPerSample = format.bitsPerSample / 8;
  const channels = Array.from({ length: format.channels }, () => new Float32Array(sampleCount));
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const frameOffset = dataOffset + sample * format.blockAlign;
    for (let channel = 0; channel < format.channels; channel += 1) {
      const offset = frameOffset + channel * bytesPerSample;
      let value: number;
      if (format.tag === 3) value = view.getFloat32(offset, true);
      else if (format.bitsPerSample === 8) value = (view.getUint8(offset) - 128) / 128;
      else if (format.bitsPerSample === 16) value = view.getInt16(offset, true) / 0x8000;
      else if (format.bitsPerSample === 24) {
        const unsigned = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
        value = (unsigned & 0x800000 ? unsigned - 0x1000000 : unsigned) / 0x800000;
      } else value = view.getInt32(offset, true) / 0x80000000;
      channels[channel]![sample] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    }
  }
  return { channels, sampleRate: format.sampleRate };
}

async function decodeMp3(audio: ArrayBuffer): Promise<DecodedAudio> {
  const decoder = new MPEGDecoder();
  try {
    await decoder.ready;
    const decoded = decoder.decode(new Uint8Array(audio));
    if (decoded.channelData.length === 0 || decoded.samplesDecoded === 0 || decoded.sampleRate < 1) {
      throw new Error("MP3 decoder produced no samples");
    }
    return { channels: decoded.channelData, sampleRate: decoded.sampleRate };
  } finally {
    decoder.free();
  }
}

function frameLevels(decoded: DecodedAudio): { levels: number[]; samplesPerFrame: number } {
  const samplesPerFrame = Math.max(1, Math.round(decoded.sampleRate * frameDurationSec));
  const sampleCount = decoded.channels[0]?.length ?? 0;
  const levels: number[] = [];
  for (let start = 0; start < sampleCount; start += samplesPerFrame) {
    const end = Math.min(sampleCount, start + samplesPerFrame);
    let squareSum = 0;
    let count = 0;
    for (const channel of decoded.channels) {
      for (let sample = start; sample < end; sample += 1) {
        const value = channel[sample] ?? 0;
        squareSum += value * value;
        count += 1;
      }
    }
    levels.push(count === 0 ? 0 : Math.sqrt(squareSum / count));
  }
  return { levels, samplesPerFrame };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function findRanges(decoded: DecodedAudio): Array<{ start: number; end: number }> {
  const sampleCount = decoded.channels[0]?.length ?? 0;
  if (sampleCount === 0) return [];
  const { levels, samplesPerFrame } = frameLevels(decoded);
  const threshold = Math.min(0.03, Math.max(0.003, percentile(levels, 0.2) * 2.5));
  const minimumSilentFrames = Math.ceil(minimumSilenceSec / frameDurationSec);
  const minimumChunkSamples = Math.ceil(minimumChunkSec * decoded.sampleRate);
  const paddingSamples = Math.ceil(edgePaddingSec * decoded.sampleRate);
  const cuts: number[] = [];

  for (let index = 0; index < levels.length;) {
    if ((levels[index] ?? 0) > threshold) {
      index += 1;
      continue;
    }
    const runStart = index;
    while (index < levels.length && (levels[index] ?? 0) <= threshold) index += 1;
    if (index - runStart < minimumSilentFrames) continue;
    const silentStart = runStart * samplesPerFrame;
    const silentEnd = Math.min(sampleCount, index * samplesPerFrame);
    if (silentStart >= minimumChunkSamples && sampleCount - silentEnd >= minimumChunkSamples) {
      cuts.push(Math.round((silentStart + silentEnd) / 2));
    }
  }

  if (cuts.length === 0) return [{ start: 0, end: sampleCount }];
  const selectedCuts = cuts.slice(0, maximumChunks - 1);
  const boundaries = [0, ...selectedCuts, sampleCount];
  return boundaries.slice(0, -1).map((start, index) => ({
    start: Math.max(0, start - (index === 0 ? 0 : paddingSamples)),
    end: Math.min(sampleCount, (boundaries[index + 1] ?? sampleCount) + (index === boundaries.length - 2 ? 0 : paddingSamples)),
  }));
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

function encodeMonoWav(decoded: DecodedAudio, start: number, end: number): ArrayBuffer {
  const sampleCount = Math.max(0, end - start);
  const output = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(output);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, output.byteLength - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, decoded.sampleRate, true);
  view.setUint32(28, decoded.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);
  for (let index = 0; index < sampleCount; index += 1) {
    let value = 0;
    for (const channel of decoded.channels) value += channel[start + index] ?? 0;
    value = Math.max(-1, Math.min(1, value / decoded.channels.length));
    view.setInt16(44 + index * 2, value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff), true);
  }
  return output;
}

export async function splitAudioOnSilence(
  audio: ArrayBuffer,
  contentType: string | null,
  filename: string,
): Promise<AudioChunk[]> {
  let decoded: DecodedAudio;
  try {
    if (isWav(contentType, filename)) decoded = decodeWav(audio);
    else if (isMp3(contentType, filename)) decoded = await decodeMp3(audio);
    else return [{ audio, contentType, startSec: 0, endSec: 0 }];
  } catch (error) {
    console.warn("audio_silence_segmentation_skipped", {
      reason: error instanceof Error ? error.message : "decode_failed",
    });
    return [{ audio, contentType, startSec: 0, endSec: 0 }];
  }

  const durationSec = (decoded.channels[0]?.length ?? 0) / decoded.sampleRate;
  const ranges = findRanges(decoded);
  if (ranges.length <= 1) return [{ audio, contentType, startSec: 0, endSec: durationSec }];
  return ranges.map((range) => ({
    audio: encodeMonoWav(decoded, range.start, range.end),
    contentType: "audio/wav",
    startSec: range.start / decoded.sampleRate,
    endSec: range.end / decoded.sampleRate,
  }));
}
