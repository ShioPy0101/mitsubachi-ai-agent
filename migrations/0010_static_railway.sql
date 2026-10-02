-- Static IDs are snapshot-local. Preserve legacy resolution IDs as audit values,
-- remove their master FK, and record provenance for future static resolutions.
CREATE TABLE railway_audio_clips_static (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, clip_index INTEGER NOT NULL,
  raw_transcription TEXT NOT NULL, normalized_transcription TEXT,
  station TEXT, line TEXT, train_type TEXT, train_name TEXT, train_number TEXT,
  destination TEXT, departure_time TEXT, arrival_time TEXT, platform TEXT,
  next_station TEXT, category TEXT NOT NULL, summary TEXT, generated_filename TEXT,
  created_at TEXT NOT NULL, resolved_station_id INTEGER,
  station_resolution_confidence REAL, station_resolution_source TEXT,
  railway_data_version TEXT,
  FOREIGN KEY(job_id) REFERENCES audio_jobs(id), UNIQUE(job_id, clip_index)
);
INSERT INTO railway_audio_clips_static SELECT id, job_id, clip_index,
 raw_transcription, normalized_transcription, station, line, train_type, train_name,
 train_number, destination, departure_time, arrival_time, platform, next_station,
 category, summary, generated_filename, created_at, resolved_station_id,
 station_resolution_confidence, station_resolution_source, 'legacy-d1'
FROM railway_audio_clips;
DROP TABLE railway_audio_clips;
ALTER TABLE railway_audio_clips_static RENAME TO railway_audio_clips;
CREATE INDEX idx_railway_audio_clips_job ON railway_audio_clips(job_id);
DROP TABLE route_segment_connections;
DROP TABLE station_line_positions;
DROP TABLE stations;
