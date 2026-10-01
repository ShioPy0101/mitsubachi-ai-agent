import { CallbackSecretsRepository } from "../db/callback-secrets-repository";
import { ClipsRepository } from "../db/clips-repository";
import { JobsRepository } from "../db/jobs-repository";

export type ProcessingJobs = Pick<
  JobsRepository,
  "updateStatus" | "isActive" | "saveTranscription" | "clearEphemeral"
> &
  Partial<Pick<JobsRepository, "setStage">>;

export type ProcessingCallbacks = Pick<CallbackSecretsRepository, "get">;

export type ProcessingClips = {
  save(input: Parameters<ClipsRepository["save"]>[0]): Promise<void>;
};

export type ProcessingResources = {
  jobs: ProcessingJobs;
  callbacks: ProcessingCallbacks;
  clips: ProcessingClips;
  sendAlerts: boolean;
  showDemoDiagnostics?: boolean;
};

export const stageTimeouts = {
  discordCallbackLookup: 15_000,
  attachmentDownload: 45_000,

  geminiAnalysis: 90_000,
  stationCandidates: 90_000,
  geminiNormalization: 90_000,

  transcriptionCheckpoint: 20_000,
  clipSave: 20_000,

  resultNotification: 45_000,
  ephemeralCleanup: 20_000,
  completionStatus: 20_000,
} as const;
