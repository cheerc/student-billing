-- PR-4: preserve the one bounded pre-refactor summary-role condition on new immutable snapshots.
ALTER TABLE run_class_semantics
  ADD COLUMN summary_day_role_conditions_json TEXT NOT NULL DEFAULT '[]';
