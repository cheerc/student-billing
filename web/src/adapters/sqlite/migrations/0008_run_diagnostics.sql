-- #161: new runs persist an immutable comparison snapshot. Existing rows remain NULL;
-- the migration deliberately does not infer historical versions or write payloads.
ALTER TABLE calculation_runs ADD COLUMN diagnostic_algorithm_version TEXT;

CREATE TABLE run_diagnostics (
  run_id TEXT PRIMARY KEY,
  algorithm_version TEXT NOT NULL,
  payload_schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  effective_inputs_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  effective_inputs_hash TEXT NOT NULL,
  formal_result_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES calculation_runs (id) ON DELETE CASCADE
);

CREATE TRIGGER run_diagnostics_immutable_update
BEFORE UPDATE ON run_diagnostics
BEGIN
  SELECT RAISE(ABORT, 'run diagnostics are immutable');
END;
