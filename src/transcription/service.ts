export type TranscriptionSegment = {
  startSec: number;
  endSec: number;
  text: string;
};

export type TranscriptionResult = {
  language: string | null;
  text: string;
  segments: TranscriptionSegment[];
  audioPreparation?: {
    strategy: "original" | "mp3_streaming_wav_chunks";
    originalBytes: number;
    submittedBytes: number;
    initialDecodeError: string | null;
    chunkCount?: number;
  };
};

export type TranscriptionInput = {
  audio: ArrayBuffer;
  contentType: string | null;
  filename: string;
  durationSecs?: number | null;
};

export interface TranscriptionService {
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}
