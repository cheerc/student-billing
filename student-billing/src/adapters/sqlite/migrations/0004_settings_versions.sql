-- 0004_settings_versions.sql: 設定版本快照與預覽草稿表

CREATE TABLE IF NOT EXISTS settings_versions (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  effective_from TEXT,
  effective_to TEXT,
  created_at TEXT NOT NULL,
  created_from_preview_id TEXT,
  revision INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings_previews (
  preview_id TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  settings_version_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_settings_versions_revision ON settings_versions (revision);
