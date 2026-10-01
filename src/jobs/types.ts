import type { TranscriptionSegment } from "../transcription/service";

export const jobStatuses = [
  "pending",
  "queued",
  "transcribing",
  "metadata_extracting",
  "completed",
  "partial",
  "failed",
] as const;
export type JobStatus = (typeof jobStatuses)[number];

export type DemoAudioJobMessage = {
  kind: "demo";
  interactionId: string;
  interactionToken: string;
  userId: string;
  attachment: {
    id: string;
    filename: string;
    size: number;
    url: string;
    contentType: string | null;
    durationSecs: number | null;
  };
};

export type PersistedAudioJobMessage = { kind?: "persisted"; jobId: string };

export type AudioJobMessage = PersistedAudioJobMessage | DemoAudioJobMessage;

export type InteractionAudioSource = {
  type: "interaction";
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  interactionId: string;
  attachmentId: string;
  temporaryReference: { url: string; expiresAt: string | null } | null;
};

export type AudioJob = {
  id: string;
  source: InteractionAudioSource;
  originalFilename: string;
  contentType: string | null;
  sizeBytes: number;
  durationSecs: number | null;
  status: JobStatus;
  errorMessage: string | null;
  transcriptionText: string | null;
  transcriptionSegments: TranscriptionSegment[] | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type NewAudioJob = {
  source: InteractionAudioSource;
  interactionCallback?: {
    token: string;
    expiresAt: string;
  };
  originalFilename: string;
  contentType: string | null;
  sizeBytes: number;
  durationSecs: number | null;
};
