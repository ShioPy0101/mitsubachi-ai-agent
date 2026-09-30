CREATE TABLE job_monitor_messages (
  job_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  current_stage TEXT NOT NULL,
  stage_detail TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'running', 'retrying', 'cancel_requested', 'stopped', 'completed', 'failed', 'timed_out'
  )),
  queue_attempt INTEGER NOT NULL,
  user_id TEXT,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  stage_started_at TEXT NOT NULL,
  stage_timeout_at TEXT,
  updated_at TEXT NOT NULL,
  cancellation_requested_at TEXT,
  completed_at TEXT,
  error_message TEXT
);

CREATE INDEX idx_job_monitor_messages_state_updated
  ON job_monitor_messages(state, updated_at);
