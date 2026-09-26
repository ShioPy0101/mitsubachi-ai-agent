export type TranscriptionSegment = {
  startSec: number;
  endSec: number;
  text: string;
};

export type TranscriptionResult = {
  language: string | null;
  text: string;
  segments: TranscriptionSegment[];
};

export type TranscriptionInput = {
  audio: ArrayBuffer;
  contentType: string | null;
  filename: string;
};

export interface TranscriptionService {
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}
