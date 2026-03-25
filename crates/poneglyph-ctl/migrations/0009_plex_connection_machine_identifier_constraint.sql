DROP INDEX IF EXISTS idx_plex_connections_machine_identifier;

CREATE UNIQUE INDEX IF NOT EXISTS idx_plex_connections_machine_identifier
  ON plex_connections(machine_identifier);
