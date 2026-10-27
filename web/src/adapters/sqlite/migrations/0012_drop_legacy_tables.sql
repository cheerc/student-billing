-- Migration 0012: Drop retired per-run diagnostics and class-semantics tables (#177 Phase 3).
-- 0011 already copied class_type / resolved_base_name into run_class_categories, the single snapshot.
DROP TRIGGER IF EXISTS run_diagnostics_immutable_update;
DROP TRIGGER IF EXISTS run_semantics_snapshots_immutable_update;
DROP TRIGGER IF EXISTS run_class_semantics_immutable_update;
DROP TABLE IF EXISTS run_diagnostics;
DROP TABLE IF EXISTS run_class_semantics;
DROP TABLE IF EXISTS run_semantics_snapshots;
