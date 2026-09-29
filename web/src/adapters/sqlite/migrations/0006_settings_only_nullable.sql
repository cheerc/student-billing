-- 0006_settings_only_nullable.sql: 無學生的 settings_only 儲存所需的欄位放寬（09 §8.2.3）
--
-- settings_previews.import_id（0004）與 idempotency_records.run_id（0003）原為 NOT NULL，
-- settings_only 沒有名單批次也沒有 run，兩欄須可為 NULL。SQLite 不能以 ALTER 移除 NOT NULL，
-- 故以 table rebuild：建新表（欄位可 null）→ INSERT…SELECT 逐列複製 → DROP 舊表 → RENAME。
-- 兩張表在同一個 migration transaction 內重建（migrator 每個檔案獨立 transaction，失敗整段 rollback）。
-- settings_previews 保留 0005 新增的 expires_at。這兩張表沒有其他索引，也不被其他表外鍵引用。

CREATE TABLE idempotency_records_rebuild (
  idempotency_key TEXT PRIMARY KEY,
  request_body_hash TEXT NOT NULL,
  run_id TEXT,
  response_payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO idempotency_records_rebuild
  (idempotency_key, request_body_hash, run_id, response_payload, created_at)
SELECT idempotency_key, request_body_hash, run_id, response_payload, created_at
FROM idempotency_records;

DROP TABLE idempotency_records;
ALTER TABLE idempotency_records_rebuild RENAME TO idempotency_records;

CREATE TABLE settings_previews_rebuild (
  preview_id TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  settings_version_id TEXT NOT NULL,
  import_id TEXT,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

INSERT INTO settings_previews_rebuild
  (preview_id, input_hash, draft_json, expected_revision, settings_version_id, import_id, result_json, created_at, expires_at)
SELECT preview_id, input_hash, draft_json, expected_revision, settings_version_id, import_id, result_json, created_at, expires_at
FROM settings_previews;

DROP TABLE settings_previews;
ALTER TABLE settings_previews_rebuild RENAME TO settings_previews;
