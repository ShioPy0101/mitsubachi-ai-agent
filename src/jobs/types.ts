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

export type AudioJobMessage = { jobId: string };

export type InteractionAudioSource = {
  type: "interaction";
  guildId: string | null;
  channelId: string | null;
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
