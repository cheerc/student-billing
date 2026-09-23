-- 0001_init.sql: 初始 Schema 定義（ActiveState 與 ImportBatch）

CREATE TABLE IF NOT EXISTS active_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_import_id TEXT,
  active_run_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO active_state (id, active_import_id, active_run_id, revision, updated_at)
VALUES (1, NULL, NULL, 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  sheet_name TEXT,
  header_map TEXT,
  parser_version TEXT NOT NULL,
  scope_note TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
