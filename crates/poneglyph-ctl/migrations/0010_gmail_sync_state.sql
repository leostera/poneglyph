CREATE TABLE IF NOT EXISTS gmail_sync_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL UNIQUE,
  last_history_id TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(connection_id) REFERENCES google_oauth_connections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_gmail_sync_state_connection_id
  ON gmail_sync_state(connection_id);
