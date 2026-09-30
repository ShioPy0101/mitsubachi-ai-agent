CREATE TABLE station_line_positions (
  line_id TEXT NOT NULL,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  PRIMARY KEY (line_id, station_id),
  UNIQUE (line_id, seq)
);

CREATE INDEX idx_station_line_positions_line_seq
ON station_line_positions(line_id, seq);

CREATE INDEX idx_station_line_positions_station
ON station_line_positions(station_id);

CREATE TABLE route_segment_connections (
  from_segment_id TEXT NOT NULL,
  to_segment_id TEXT NOT NULL,
  from_station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  to_station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL,
  transfer_cost INTEGER NOT NULL CHECK (transfer_cost IN (0, 1)),
  PRIMARY KEY (from_segment_id, to_segment_id, from_station_id, to_station_id)
);

CREATE INDEX idx_route_segment_connections_from
ON route_segment_connections(from_segment_id);

CREATE INDEX idx_route_segment_connections_to
ON route_segment_connections(to_segment_id);
