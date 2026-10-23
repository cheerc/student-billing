-- PR-3: additive semantic snapshot for new runs. Historical rows are intentionally untouched.
-- The one-to-one marker preserves the distinction between a new empty snapshot and no snapshot.
CREATE TABLE IF NOT EXISTS run_semantics_snapshots (
  run_id TEXT PRIMARY KEY,
  snapshot_schema_version INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES calculation_runs (id) ON DELETE CASCADE
);

CREATE TRIGGER run_semantics_snapshots_immutable_update
BEFORE UPDATE ON run_semantics_snapshots
BEGIN
  SELECT RAISE(ABORT, 'run semantics snapshot header is immutable');
END;

CREATE TABLE IF NOT EXISTS run_class_semantics (
  run_id TEXT NOT NULL,
  base_name TEXT NOT NULL,
  resolved_base_name TEXT NOT NULL,
  snapshot_schema_version INTEGER NOT NULL,
  class_type_id TEXT,
  class_type_definition_json TEXT,
  class_type_definition_hash TEXT,
  subject TEXT NOT NULL,
  subject_source TEXT NOT NULL,
  category TEXT NOT NULL,
  category_source TEXT NOT NULL,
  fixed_five_days INTEGER NOT NULL,
  summary_day_roles_json TEXT NOT NULL,
  summary_day_roles_status TEXT NOT NULL,
  summary_day_roles_source TEXT NOT NULL,
  erp_tier_applicability TEXT NOT NULL,
  erp_tier_applicability_source TEXT NOT NULL,
  PRIMARY KEY (run_id, base_name),
  FOREIGN KEY (run_id) REFERENCES calculation_runs (id) ON DELETE CASCADE
);

CREATE TRIGGER run_class_semantics_immutable_update
BEFORE UPDATE ON run_class_semantics
BEGIN
  SELECT RAISE(ABORT, 'run class semantics are immutable');
END;
