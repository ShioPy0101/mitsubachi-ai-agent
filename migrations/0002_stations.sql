CREATE TABLE stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kana TEXT,
  kana_source TEXT,
  operator_name TEXT,
  line_name TEXT,
  prefecture TEXT,
  prev_station TEXT,
  next_station TEXT,
  longitude REAL,
  latitude REAL,
  postal TEXT,
  normalized_name TEXT NOT NULL,
  normalized_kana TEXT
);

CREATE UNIQUE INDEX idx_stations_identity
ON stations(name, COALESCE(line_name, ''), COALESCE(operator_name, ''));

CREATE INDEX idx_stations_name ON stations(name);
CREATE INDEX idx_stations_normalized_name ON stations(normalized_name);
CREATE INDEX idx_stations_normalized_kana ON stations(normalized_kana);
CREATE INDEX idx_stations_line_name ON stations(line_name);
CREATE INDEX idx_stations_prefecture ON stations(prefecture);
CREATE INDEX idx_stations_line_normalized_kana ON stations(line_name, normalized_kana);

ALTER TABLE railway_audio_clips ADD COLUMN resolved_station_id INTEGER REFERENCES stations(id);
ALTER TABLE railway_audio_clips ADD COLUMN station_resolution_confidence REAL;
ALTER TABLE railway_audio_clips ADD COLUMN station_resolution_source TEXT;
