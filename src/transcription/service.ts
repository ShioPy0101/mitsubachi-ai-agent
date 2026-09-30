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
    strategy: "original" | "mp3_rebuilt";
    originalBytes: number;
    submittedBytes: number;
    initialDecodeError: string | null;
    rebuiltDecodeError?: string | null;
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
