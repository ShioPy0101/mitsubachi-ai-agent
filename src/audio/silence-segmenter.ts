import CodecParser, { type CodecFrame } from "codec-parser";

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
const mp3DecodeBatchFrames = 96;
const mp3ReservoirPaddingFrames = 10;

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

async function loadMp3Decoder(): Promise<(new (options?: { enableGapless?: boolean }) => {
  ready: Promise<void>;
  decodeFrames(frames: Uint8Array[]): {
    channelData: Float32Array[];
    samplesDecoded: number;
    sampleRate: number;
  };
  free(): void;
})> {
  // mpg123-decoder exports an unused browser Web Worker adapter from its root module.
  // Workers does not expose that constructor, so install a harmless placeholder before
  // loading the package; decoding below uses only the synchronous WASM implementation.
  const runtime = globalThis as typeof globalThis & { Worker?: unknown };
  runtime.Worker ??= class UnsupportedWorker {};
  const { MPEGDecoder } = await import("mpg123-decoder");
  return MPEGDecoder;
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

function evenlyLimited<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  if (limit <= 1) return [values[Math.floor(values.length / 2)]!];
  return Array.from({ length: limit }, (_value, index) =>
    values[Math.round(index * (values.length - 1) / (limit - 1))]!);
}

function rms(channels: Float32Array[], start: number, end: number): number {
  let squareSum = 0;
  let count = 0;
  for (const channel of channels) {
    for (let sample = start; sample < end; sample += 1) {
      const value = channel[sample] ?? 0;
      squareSum += value * value;
      count += 1;
    }
  }
  return count === 0 ? 0 : Math.sqrt(squareSum / count);
}

function mp3FrameStartSec(frame: CodecFrame): number {
  return frame.totalDuration / 1_000;
}

function mp3FrameEndSec(frame: CodecFrame): number {
  return (frame.totalDuration + frame.duration) / 1_000;
}

function timeRangesFromFrameLevels(frames: CodecFrame[], levels: number[]): Array<{ start: number; end: number }> {
  if (frames.length === 0 || levels.length !== frames.length) return [];
  const threshold = Math.min(0.03, Math.max(0.003, percentile(levels, 0.2) * 2.5));
  const firstActive = levels.findIndex((level) => level > threshold);
  if (firstActive < 0) return [{ start: 0, end: mp3FrameEndSec(frames.at(-1)!) }];
  let lastActive = levels.length - 1;
  while (lastActive > firstActive && (levels[lastActive] ?? 0) <= threshold) lastActive -= 1;
  const trimmedStart = Math.max(0, mp3FrameStartSec(frames[firstActive]!) - edgePaddingSec);
  const trimmedEnd = Math.min(mp3FrameEndSec(frames.at(-1)!), mp3FrameEndSec(frames[lastActive]!) + edgePaddingSec);

  const silentRuns: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < levels.length;) {
    if ((levels[index] ?? 0) > threshold) {
      index += 1;
      continue;
    }
    const runStart = index;
    while (index < levels.length && (levels[index] ?? 0) <= threshold) index += 1;
    const start = mp3FrameStartSec(frames[runStart]!);
    const end = mp3FrameEndSec(frames[index - 1]!);
    if (end - start >= minimumSilenceSec) silentRuns.push({ start, end });
  }

  const ranges: Array<{ start: number; end: number }> = [];
  let currentStart = trimmedStart;
  for (const silence of evenlyLimited(silentRuns, maximumChunks - 1)) {
    const previousEnd = Math.min(trimmedEnd, silence.start + edgePaddingSec);
    const nextStart = Math.max(trimmedStart, silence.end - edgePaddingSec);
    if (previousEnd - currentStart < minimumChunkSec || trimmedEnd - nextStart < minimumChunkSec) continue;
    ranges.push({ start: currentStart, end: previousEnd });
    currentStart = nextStart;
  }
  ranges.push({ start: currentStart, end: trimmedEnd });
  return ranges;
}

function concatenateFrameData(frames: CodecFrame[], start: number, end: number): ArrayBuffer {
  const byteLength = frames.slice(start, end).reduce((total, frame) => total + frame.data.byteLength, 0);
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (let index = start; index < end; index += 1) {
    const data = frames[index]!.data;
    output.set(data, offset);
    offset += data.byteLength;
  }
  return output.buffer;
}

async function splitMp3OnSilence(audio: ArrayBuffer, contentType: string | null): Promise<AudioChunk[]> {
  const parser = new CodecParser<CodecFrame>("audio/mpeg", { enableFrameCRC32: false });
  const frames = parser.parseAll(new Uint8Array(audio));
  if (frames.length === 0) throw new Error("MP3 parser produced no frames");

  const MPEGDecoder = await loadMp3Decoder();
  const decoder = new MPEGDecoder({ enableGapless: false });
  const levels: number[] = [];
  try {
    await decoder.ready;
    for (let offset = 0; offset < frames.length; offset += mp3DecodeBatchFrames) {
      const batch = frames.slice(offset, offset + mp3DecodeBatchFrames);
      const decoded = decoder.decodeFrames(batch.map((frame) => frame.data));
      if (decoded.channelData.length === 0 || decoded.sampleRate < 1) throw new Error("MP3 decoder produced no samples");
      let sampleOffset = 0;
      for (const frame of batch) {
        const sampleEnd = Math.min(decoded.samplesDecoded, sampleOffset + frame.samples);
        levels.push(rms(decoded.channelData, sampleOffset, sampleEnd));
        sampleOffset = sampleEnd;
      }
    }
  } finally {
    decoder.free();
  }

  const ranges = timeRangesFromFrameLevels(frames, levels);
  const fullDuration = mp3FrameEndSec(frames.at(-1)!);
  if (ranges.length === 0 || (ranges.length === 1 && ranges[0]?.start === 0 && ranges[0].end >= fullDuration)) {
    return [{ audio, contentType, startSec: 0, endSec: fullDuration }];
  }
  return ranges.map((range) => {
    const firstOverlapping = frames.findIndex((frame) => mp3FrameEndSec(frame) > range.start);
    const startFrame = Math.max(0, firstOverlapping - mp3ReservoirPaddingFrames);
    let endFrame = frames.findIndex((frame) => mp3FrameStartSec(frame) >= range.end);
    if (endFrame < 0) endFrame = frames.length;
    return {
      audio: concatenateFrameData(frames, startFrame, endFrame),
      contentType: "audio/mpeg",
      startSec: mp3FrameStartSec(frames[startFrame]!),
      endSec: mp3FrameEndSec(frames[endFrame - 1]!),
    };
  });
}

function findRanges(decoded: DecodedAudio): Array<{ start: number; end: number }> {
  const sampleCount = decoded.channels[0]?.length ?? 0;
  if (sampleCount === 0) return [];
  const { levels, samplesPerFrame } = frameLevels(decoded);
  const threshold = Math.min(0.03, Math.max(0.003, percentile(levels, 0.2) * 2.5));
  const minimumSilentFrames = Math.ceil(minimumSilenceSec / frameDurationSec);
  const minimumChunkSamples = Math.ceil(minimumChunkSec * decoded.sampleRate);
  const paddingSamples = Math.ceil(edgePaddingSec * decoded.sampleRate);
  const silentRuns: Array<{ start: number; end: number }> = [];

  for (let index = 0; index < levels.length;) {
    if ((levels[index] ?? 0) > threshold) {
      index += 1;
      continue;
    }
    const runStart = index;
    while (index < levels.length && (levels[index] ?? 0) <= threshold) index += 1;
    if (index - runStart < minimumSilentFrames) continue;
    silentRuns.push({
      start: runStart * samplesPerFrame,
      end: Math.min(sampleCount, index * samplesPerFrame),
    });
  }

  const firstActiveFrame = levels.findIndex((level) => level > threshold);
  if (firstActiveFrame < 0) return [{ start: 0, end: sampleCount }];
  let lastActiveFrame = levels.length - 1;
  while (lastActiveFrame > firstActiveFrame && (levels[lastActiveFrame] ?? 0) <= threshold) lastActiveFrame -= 1;
  const trimmedStart = Math.max(0, firstActiveFrame * samplesPerFrame - paddingSamples);
  const trimmedEnd = Math.min(sampleCount, (lastActiveFrame + 1) * samplesPerFrame + paddingSamples);

  const ranges: Array<{ start: number; end: number }> = [];
  let currentStart = trimmedStart;
  for (const silence of evenlyLimited(silentRuns, maximumChunks - 1)) {
    const previousEnd = Math.min(trimmedEnd, silence.start + paddingSamples);
    const nextStart = Math.max(trimmedStart, silence.end - paddingSamples);
    if (previousEnd - currentStart < minimumChunkSamples || trimmedEnd - nextStart < minimumChunkSamples) continue;
    ranges.push({ start: currentStart, end: previousEnd });
    currentStart = nextStart;
  }
  ranges.push({ start: currentStart, end: trimmedEnd });
  return ranges;
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
  _durationSecs?: number | null,
): Promise<AudioChunk[]> {
  if (isMp3(contentType, filename)) {
    try {
      return await splitMp3OnSilence(audio, contentType);
    } catch (error) {
      console.warn("audio_silence_segmentation_skipped", {
        reason: error instanceof Error ? error.message : "mp3_decode_failed",
      });
      return [{ audio, contentType, startSec: 0, endSec: _durationSecs ?? 0 }];
    }
  }
  let decoded: DecodedAudio;
  try {
    if (isWav(contentType, filename)) decoded = decodeWav(audio);
    else return [{ audio, contentType, startSec: 0, endSec: 0 }];
  } catch (error) {
    console.warn("audio_silence_segmentation_skipped", {
      reason: error instanceof Error ? error.message : "decode_failed",
    });
    return [{ audio, contentType, startSec: 0, endSec: 0 }];
  }

  const durationSec = (decoded.channels[0]?.length ?? 0) / decoded.sampleRate;
  const ranges = findRanges(decoded);
  const onlyRange = ranges[0];
  if (ranges.length === 1 && onlyRange?.start === 0 && onlyRange.end === (decoded.channels[0]?.length ?? 0)) {
    return [{ audio, contentType, startSec: 0, endSec: durationSec }];
  }
  return ranges.map((range) => ({
    audio: encodeMonoWav(decoded, range.start, range.end),
    contentType: "audio/wav",
    startSec: range.start / decoded.sampleRate,
    endSec: range.end / decoded.sampleRate,
  }));
}
