CREATE TABLE IF NOT EXISTS filesystem_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  canonical_root_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_filesystem_connections_canonical_root_path
  ON filesystem_connections(canonical_root_path);
