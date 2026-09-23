-- 0003_runs_and_calculations.sql: 建立正式計算 run 與學生計算結果資料表

CREATE TABLE IF NOT EXISTS calculation_runs (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL,
  schedule_version_id TEXT NOT NULL,
  rule_set_version TEXT NOT NULL,
  numeric_policy TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  status TEXT NOT NULL,
  issue_counts TEXT NOT NULL,
  total_students INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (import_id) REFERENCES import_batches (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS student_calculations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  person_code TEXT NOT NULL,
  name TEXT NOT NULL,
  branch TEXT,
  grade INTEGER,
  grade_raw TEXT,
  subject_count INTEGER,
  base_discount_bps INTEGER,
  anqin_days REAL,
  anqin_display TEXT,
  tutoring_days REAL,
  tutoring_display TEXT,
  english_days REAL,
  math_days REAL,
  chinese_days REAL,
  homework_days REAL,
  intensive_english_days REAL,
  saturday_tutoring_days REAL,
  applicable_anqin_bps INTEGER,
  applicable_tutoring_bps INTEGER,
  applicable_english_bps INTEGER,
  applicable_math_bps INTEGER,
  tier_mismatch INTEGER NOT NULL DEFAULT 0,
  tier_comparisons TEXT NOT NULL,
  issues TEXT NOT NULL,
  has_issues INTEGER NOT NULL DEFAULT 0,
  trace TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES calculation_runs (id) ON DELETE CASCADE,
  UNIQUE(run_id, person_code)
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  idempotency_key TEXT PRIMARY KEY,
  request_body_hash TEXT NOT NULL,
  run_id TEXT NOT NULL,
  response_payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_student_calculations_run ON student_calculations (run_id);
CREATE INDEX IF NOT EXISTS idx_student_calculations_person ON student_calculations (person_code);
CREATE INDEX IF NOT EXISTS idx_student_calculations_mismatch ON student_calculations (run_id, tier_mismatch);
CREATE INDEX IF NOT EXISTS idx_student_calculations_issues ON student_calculations (run_id, has_issues);
