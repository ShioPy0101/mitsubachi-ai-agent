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

export type AudioJobMessage = { kind?: "persisted"; jobId: string };

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
  createdAt: string;
  /** Legacy transcription start, never the job clock. */
  startedAt: string | null;
  processingStartedAt?: string | null;
  deadlineAt?: string | null;
  stage?: string | null;
  stageStartedAt?: string | null;
  failureCode?: string | null;
  presentationMode?: "public" | "demo";
  completedAt: string | null;
};

export type NewAudioJob = {
  presentationMode?: "public" | "demo";
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
