-- Migration 0011: Expand run_class_categories with class_type and resolved_base_name
-- This enables a single authoritative class categories snapshot for calculations and billing comparisons.

ALTER TABLE run_class_categories ADD COLUMN class_type TEXT;
ALTER TABLE run_class_categories ADD COLUMN resolved_base_name TEXT;

-- One-time backfill: copy class_type and resolved_base_name from run_class_semantics for existing runs
UPDATE run_class_categories
SET class_type = (
  SELECT rcs.class_type_id
  FROM run_class_semantics rcs
  WHERE rcs.run_id = run_class_categories.run_id
    AND rcs.base_name = run_class_categories.base_name
    AND rcs.class_type_id IN ('care', 'non_care')
),
resolved_base_name = COALESCE(
  (
    SELECT rcs.resolved_base_name
    FROM run_class_semantics rcs
    WHERE rcs.run_id = run_class_categories.run_id
      AND rcs.base_name = run_class_categories.base_name
  ),
  run_class_categories.base_name
)
WHERE EXISTS (
  SELECT 1 FROM run_class_semantics rcs
  WHERE rcs.run_id = run_class_categories.run_id
    AND rcs.base_name = run_class_categories.base_name
);

-- Fallback for rows without run_class_semantics: default resolved_base_name to base_name
UPDATE run_class_categories
SET resolved_base_name = base_name
WHERE resolved_base_name IS NULL;
