-- 0002_students_enrollments.sql: 建立匯入學生與報名班級快照資料表

CREATE TABLE IF NOT EXISTS imported_students (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL,
  person_code TEXT NOT NULL,
  name TEXT NOT NULL,
  branch TEXT,
  grade_raw TEXT,
  grade INTEGER,
  grade_status TEXT NOT NULL,
  contact TEXT,
  school_info TEXT,
  tags_raw TEXT,
  notes_raw TEXT,
  source_row INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (import_id) REFERENCES import_batches (id) ON DELETE CASCADE,
  UNIQUE(import_id, person_code)
);

CREATE TABLE IF NOT EXISTS student_enrollments (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL,
  person_code TEXT NOT NULL,
  token_index INTEGER NOT NULL,
  raw_token TEXT NOT NULL,
  year_prefix TEXT,
  base_name TEXT NOT NULL,
  group_flag TEXT,
  modifiers TEXT, -- JSON 字串，如 '["4_5"]'
  withdrawal_date TEXT,
  erp_billing_tier_raw TEXT,
  erp_billing_tier REAL,
  tier_parse_status TEXT NOT NULL,
  parse_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (import_id) REFERENCES import_batches (id) ON DELETE CASCADE,
  FOREIGN KEY (import_id, person_code) REFERENCES imported_students (import_id, person_code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_imported_students_import ON imported_students (import_id);
CREATE INDEX IF NOT EXISTS idx_imported_students_person_code ON imported_students (person_code);
CREATE INDEX IF NOT EXISTS idx_student_enrollments_import ON student_enrollments (import_id);
CREATE INDEX IF NOT EXISTS idx_student_enrollments_base_name ON student_enrollments (base_name);
