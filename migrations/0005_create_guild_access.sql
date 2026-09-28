CREATE TABLE guild_access (
  guild_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_by_user_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
