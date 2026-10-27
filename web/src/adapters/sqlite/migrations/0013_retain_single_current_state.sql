-- Migration 0013: Retain single current state in SQLite (#177 Phase 4).
-- Delete old non-current calculation runs, import batches, older settings versions, previews, and idempotency records.

DELETE FROM calculation_runs WHERE id != COALESCE((SELECT active_run_id FROM active_state WHERE id = 1), '');
DELETE FROM import_batches WHERE id != COALESCE((SELECT active_import_id FROM active_state WHERE id = 1), '');
DELETE FROM settings_versions WHERE revision != COALESCE((SELECT MAX(revision) FROM settings_versions), -1);
DELETE FROM settings_previews;
DELETE FROM idempotency_records;
