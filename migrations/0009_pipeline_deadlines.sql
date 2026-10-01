-- started_at remains the historical transcription clock.
ALTER TABLE audio_jobs ADD COLUMN processing_started_at TEXT;
ALTER TABLE audio_jobs ADD COLUMN deadline_at TEXT;
ALTER TABLE audio_jobs ADD COLUMN stage TEXT;
ALTER TABLE audio_jobs ADD COLUMN failure_code TEXT;
ALTER TABLE audio_jobs ADD COLUMN pipeline_checkpoint TEXT;
-- Existing running jobs get the maximum provider budget plus downstream allowance.
UPDATE audio_jobs SET processing_started_at = COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
 deadline_at = strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), '+20 minutes')
 WHERE status IN ('transcribing', 'metadata_extracting') OR (status = 'queued' AND started_at IS NOT NULL);
CREATE INDEX idx_audio_jobs_active_deadline ON audio_jobs(deadline_at)
 WHERE status IN ('transcribing', 'metadata_extracting') OR (status = 'queued' AND started_at IS NOT NULL);
ALTER TABLE audio_jobs ADD COLUMN presentation_mode TEXT NOT NULL DEFAULT 'public' CHECK (presentation_mode IN ('public', 'demo'));
ALTER TABLE audio_jobs ADD COLUMN stage_started_at TEXT;
