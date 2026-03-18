CREATE TABLE IF NOT EXISTS google_calendar_resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  calendar_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT,
  time_zone TEXT,
  primary_calendar INTEGER NOT NULL DEFAULT 0,
  selected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connection_id, calendar_id),
  FOREIGN KEY (connection_id) REFERENCES google_oauth_connections(id) ON DELETE CASCADE
);
