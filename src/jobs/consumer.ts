import { z } from "zod";
import { CallbackSecretsRepository } from "../db/callback-secrets-repository";
import { ClipsRepository } from "../db/clips-repository";
import { JobsRepository } from "../db/jobs-repository";
import { D1StationsRepository } from "../db/stations-repository";
import { AttachmentUnavailableError, DiscordRestClient } from "../discord/rest-client";
import { formatAnalysisResult, formatFailure } from "../discord/messages";
import { GeminiMetadataService } from "../metadata/gemini";
import { generateRailwayFilename } from "../railway/filename";
import type { RailwayAnnouncementMetadata } from "../railway/types";
import { StationCandidateService } from "../stations/candidate-service";
import { resolveStation } from "../stations/resolver";
import { CloudflareWhisperTranscriptionService } from "../transcription/workers-ai";
import type { AudioJob, AudioJobMessage } from "./types";

const AudioJobMessageSchema = z.object({ jobId: z.string().uuid() });
const terminalStatuses = new Set(["completed", "partial", "failed"]);

function maxAudioBytes(env: Env): number {
  const parsed = Number(env.MAX_AUDIO_BYTES);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 25 * 1024 * 1024;
}

function attachmentFor(job: AudioJob): { id: string; filename: string; size: number; url: string; contentType: string | null; durationSecs: number | null } {
  const reference = job.source.temporaryReference;
  if (reference === null) throw new AttachmentUnavailableError("attachment_unavailable");
  if (reference.expiresAt !== null && Date.parse(reference.expiresAt) <= Date.now()) {
    throw new AttachmentUnavailableError("attachment_unavailable");
  }
  return {
    id: job.source.attachmentId,
    filename: job.originalFilename,
    size: job.sizeBytes,
    url: reference.url,
    contentType: job.contentType,
    durationSecs: job.durationSecs,
  };
}

async function notify(
  job: AudioJob,
  content: string,
  callbacks: CallbackSecretsRepository,
  discord: DiscordRestClient,
): Promise<void> {
  const callback = await callbacks.get(job.id);
  let followedUp = false;
  if (callback !== null && Date.parse(callback.expiresAt) > Date.now()) {
    try {
      followedUp = await discord.followUp(callback.token, content);
    } catch {
      followedUp = false;
    }
  }
  if (!followedUp && job.source.channelId !== null) {
    try {
      await discord.sendChannelMessage(job.source.channelId, content);
    } catch {
      // The terminal state remains queryable even when Discord is temporarily unavailable.
    }
  }
}

const emptyMetadata: RailwayAnnouncementMetadata = {
  station: null, line: null, trainType: null, trainName: null, trainNumber: null, destination: null,
  departureTime: null, arrivalTime: null, platform: null, nextStation: null, category: "other", summary: null,
};

async function processJob(job: AudioJob, env: Env): Promise<void> {
  const jobs = new JobsRepository(env.DB);
  const callbacks = new CallbackSecretsRepository(env.DB);
  const clips = new ClipsRepository(env.DB);
  const discord = new DiscordRestClient(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);
  const attachment = attachmentFor(job);
  await jobs.updateStatus(job.id, "transcribing");
  const audio = await discord.downloadTemporaryAttachment(attachment, maxAudioBytes(env));
  const transcription = await new CloudflareWhisperTranscriptionService(env.AI).transcribe({
    audio, contentType: job.contentType, filename: job.originalFilename,
  });
  await jobs.updateStatus(job.id, "metadata_extracting");
  let candidates: Awaited<ReturnType<StationCandidateService["candidates"]>>;
  let extracted: Awaited<ReturnType<GeminiMetadataService["extract"]>>;
  try {
    const candidateService = new StationCandidateService(new D1StationsRepository(env.DB));
    candidates = await candidateService.candidates(transcription.text);
    extracted = await new GeminiMetadataService(env.GEMINI_API_KEY, env.GEMINI_MODEL).extract(transcription.text, candidates);
  } catch {
    const filename = generateRailwayFilename(1, emptyMetadata, job.originalFilename);
    await clips.save({
      jobId: job.id, clipIndex: 1, rawTranscription: transcription.text, normalizedTranscription: null,
      metadata: emptyMetadata,
      resolution: { stationName: null, candidateStationId: null, confidence: 0, source: "unresolved" },
      generatedFilename: filename, createdAt: new Date().toISOString(),
    });
    await jobs.updateStatus(job.id, "partial", "metadata_extraction_failed");
    await notify(job, `文字起こしは完了しましたが、メタデータ解析に失敗しました。\n\n「${transcription.text.slice(0, 1200)}」`, callbacks, discord);
    await jobs.clearEphemeral(job.id);
    return;
  }
  const resolution = resolveStation(candidates, extracted.metadata.station);
  const metadata = { ...extracted.metadata, station: resolution.stationName };
  const filename = generateRailwayFilename(1, metadata, job.originalFilename);
  await clips.save({
    jobId: job.id, clipIndex: 1, rawTranscription: transcription.text,
    normalizedTranscription: extracted.normalizedTranscription, metadata, resolution,
    generatedFilename: filename, createdAt: new Date().toISOString(),
  });
  await jobs.updateStatus(job.id, "completed");
  await notify(job, formatAnalysisResult(metadata, transcription.text, filename), callbacks, discord);
  await jobs.clearEphemeral(job.id);
}

export async function consumeAudioJobs(batch: MessageBatch<AudioJobMessage>, env: Env): Promise<void> {
  const jobs = new JobsRepository(env.DB);
  const callbacks = new CallbackSecretsRepository(env.DB);
  const discord = new DiscordRestClient(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);
  for (const message of batch.messages) {
    const parsed = AudioJobMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      message.ack();
      continue;
    }
    const job = await jobs.findById(parsed.data.jobId);
    if (job === null || terminalStatuses.has(job.status)) {
      message.ack();
      continue;
    }
    try {
      await processJob(job, env);
      message.ack();
    } catch (error) {
      if (error instanceof AttachmentUnavailableError) {
        await jobs.updateStatus(job.id, "failed", "attachment_unavailable");
        await notify(job, formatFailure("attachment_unavailable"), callbacks, discord);
        await jobs.clearEphemeral(job.id);
        message.ack();
      } else if (message.attempts < 5) {
        await jobs.updateStatus(job.id, "queued", "transient_processing_error");
        message.retry({ delaySeconds: Math.min(300, 2 ** message.attempts * 5) });
      } else {
        await jobs.updateStatus(job.id, "failed", "processing_failed");
        await notify(job, formatFailure("processing_failed"), callbacks, discord);
        await jobs.clearEphemeral(job.id);
        message.ack();
      }
    }
  }
}
