CREATE TABLE IF NOT EXISTS plex_library_sync_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_key TEXT NOT NULL UNIQUE,
  content_fingerprint TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
