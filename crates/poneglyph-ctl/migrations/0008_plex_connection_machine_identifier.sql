ALTER TABLE plex_connections RENAME TO plex_connections_old;

CREATE TABLE IF NOT EXISTS plex_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  machine_identifier TEXT,
  base_url TEXT NOT NULL,
  token TEXT NOT NULL,
  libraries TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plex_connections_machine_identifier
  ON plex_connections(machine_identifier)
  WHERE machine_identifier IS NOT NULL;

INSERT INTO plex_connections (
  id,
  name,
  machine_identifier,
  base_url,
  token,
  libraries,
  created_at,
  updated_at
)
SELECT
  id,
  COALESCE(name, ''),
  NULL,
  base_url,
  token,
  libraries,
  created_at,
  updated_at
FROM plex_connections_old;

DROP TABLE plex_connections_old;
