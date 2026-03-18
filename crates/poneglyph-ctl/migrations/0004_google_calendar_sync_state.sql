CREATE TABLE IF NOT EXISTS google_calendar_sync_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  calendar_id TEXT NOT NULL,
  next_sync_token TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connection_id, calendar_id),
  FOREIGN KEY (connection_id) REFERENCES google_oauth_connections(id) ON DELETE CASCADE
);
