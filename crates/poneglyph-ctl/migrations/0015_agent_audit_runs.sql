CREATE TABLE IF NOT EXISTS agent_audit_runs (
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  session_id TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  input_summary TEXT,
  reply_summary TEXT,
  error_summary TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_runs_started_at
  ON agent_audit_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_audit_runs_status
  ON agent_audit_runs(status);

CREATE TABLE IF NOT EXISTS agent_audit_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES agent_audit_runs(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_audit_events_run_seq
  ON agent_audit_events(run_id, seq);

CREATE INDEX IF NOT EXISTS idx_agent_audit_events_occurred_at
  ON agent_audit_events(occurred_at DESC);
