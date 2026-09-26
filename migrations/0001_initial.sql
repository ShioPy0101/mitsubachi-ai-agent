PRAGMA foreign_keys = ON;

CREATE TABLE audio_jobs (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  channel_id TEXT,
  interaction_id TEXT NOT NULL UNIQUE,
  attachment_id TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  duration_secs REAL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'transcribing', 'metadata_extracting', 'completed', 'partial', 'failed')),
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX idx_audio_jobs_status_created ON audio_jobs(status, created_at);

CREATE TABLE ephemeral_attachment_references (
  job_id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL,
  url TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES audio_jobs(id) ON DELETE CASCADE
);

CREATE TABLE interaction_callback_secrets (
  interaction_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES audio_jobs(id) ON DELETE CASCADE
);

CREATE INDEX idx_interaction_callback_expiry ON interaction_callback_secrets(expires_at);
CREATE INDEX idx_ephemeral_attachment_expiry ON ephemeral_attachment_references(expires_at);

CREATE TABLE railway_audio_clips (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  clip_index INTEGER NOT NULL,
  raw_transcription TEXT NOT NULL,
  normalized_transcription TEXT,
  station TEXT,
  line TEXT,
  train_type TEXT,
  train_name TEXT,
  train_number TEXT,
  destination TEXT,
  departure_time TEXT,
  arrival_time TEXT,
  platform TEXT,
  next_station TEXT,
  category TEXT NOT NULL,
  summary TEXT,
  generated_filename TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES audio_jobs(id),
  UNIQUE(job_id, clip_index)
);

CREATE INDEX idx_railway_audio_clips_job ON railway_audio_clips(job_id);
