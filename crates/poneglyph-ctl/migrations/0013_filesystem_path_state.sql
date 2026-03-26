CREATE TABLE IF NOT EXISTS filesystem_path_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  last_content_hash TEXT,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(connection_id) REFERENCES filesystem_connections(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_filesystem_path_state_connection_relative_path
  ON filesystem_path_state(connection_id, relative_path);
