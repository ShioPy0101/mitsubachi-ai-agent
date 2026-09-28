import { z } from "zod";
import type { RailwayAnnouncementMetadata } from "../railway/types";
import type { StationResolution } from "../stations/types";

export type NewClip = {
  jobId: string;
  clipIndex: number;
  rawTranscription: string;
  normalizedTranscription: string | null;
  metadata: RailwayAnnouncementMetadata;
  resolution: StationResolution;
  generatedFilename: string;
  createdAt: string;
};

export type ClipSearchResult = {
  station: string | null;
  line: string | null;
  trainType: string | null;
  trainName: string | null;
  destination: string | null;
  departureTime: string | null;
  nextStation: string | null;
  summary: string | null;
  rawTranscription: string;
  generatedFilename: string | null;
};

const SearchRowSchema = z.object({
  station: z.string().nullable(), line: z.string().nullable(), train_type: z.string().nullable(),
  train_name: z.string().nullable(), destination: z.string().nullable(), departure_time: z.string().nullable(),
  next_station: z.string().nullable(), summary: z.string().nullable(), raw_transcription: z.string(),
  generated_filename: z.string().nullable(),
});

export function escapedLike(value: string): string {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export class ClipsRepository {
  constructor(private readonly db: D1Database) {}

  async save(input: NewClip): Promise<void> {
    const metadata = input.metadata;
    await this.db.prepare(`
      INSERT INTO railway_audio_clips (
        id, job_id, clip_index, raw_transcription, normalized_transcription, station, line,
        train_type, train_name, train_number, destination, departure_time, arrival_time,
        platform, next_station, category, summary, generated_filename, created_at,
        resolved_station_id, station_resolution_confidence, station_resolution_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id, clip_index) DO UPDATE SET
        raw_transcription=excluded.raw_transcription,
        normalized_transcription=excluded.normalized_transcription,
        station=excluded.station, line=excluded.line, train_type=excluded.train_type,
        train_name=excluded.train_name, train_number=excluded.train_number,
        destination=excluded.destination, departure_time=excluded.departure_time,
        arrival_time=excluded.arrival_time, platform=excluded.platform,
        next_station=excluded.next_station, category=excluded.category, summary=excluded.summary,
        generated_filename=excluded.generated_filename,
        resolved_station_id=excluded.resolved_station_id,
        station_resolution_confidence=excluded.station_resolution_confidence,
        station_resolution_source=excluded.station_resolution_source
    `).bind(
      crypto.randomUUID(), input.jobId, input.clipIndex, input.rawTranscription, input.normalizedTranscription,
      metadata.station, metadata.line, metadata.trainType, metadata.trainName, metadata.trainNumber,
      metadata.destination, metadata.departureTime, metadata.arrivalTime, metadata.platform,
      metadata.nextStation, metadata.category, metadata.summary, input.generatedFilename, input.createdAt,
      input.resolution.candidateStationId, input.resolution.confidence, input.resolution.source,
    ).run();
  }

  async search(query: string, guildId: string, limit = 10): Promise<ClipSearchResult[]> {
    const pattern = escapedLike(query.trim());
    const result = await this.db.prepare(`
      SELECT c.station, c.line, c.train_type, c.train_name, c.destination, c.departure_time,
             c.next_station, c.summary, c.raw_transcription, c.generated_filename
      FROM railway_audio_clips c
      INNER JOIN audio_jobs j ON j.id = c.job_id
      WHERE j.guild_id = ? AND (
           c.station LIKE ? ESCAPE '\\' OR c.line LIKE ? ESCAPE '\\'
        OR c.train_type LIKE ? ESCAPE '\\' OR c.train_name LIKE ? ESCAPE '\\'
        OR c.destination LIKE ? ESCAPE '\\' OR c.next_station LIKE ? ESCAPE '\\'
        OR c.summary LIKE ? ESCAPE '\\' OR c.raw_transcription LIKE ? ESCAPE '\\'
        OR c.normalized_transcription LIKE ? ESCAPE '\\'
      )
      ORDER BY c.created_at DESC
      LIMIT ?
    `).bind(guildId, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, Math.min(10, limit)).all();
    return result.results.map((input) => {
      const row = SearchRowSchema.parse(input);
      return {
        station: row.station, line: row.line, trainType: row.train_type, trainName: row.train_name,
        destination: row.destination, departureTime: row.departure_time, nextStation: row.next_station,
        summary: row.summary, rawTranscription: row.raw_transcription, generatedFilename: row.generated_filename,
      };
    });
  }
}
