-- 0007_rule_set_target_and_run_class_categories.sql: D1 規則版本入口收斂所需的兩個純增量物件（specs/11 §3 D1、03 §4）
--
-- 1. settings_previews.target_rule_set_version（TEXT，可 NULL）：preview 當下由 server 決定的目標規則版本。
--    apply 只讀這個欄位建立新 run，不再落回 calculate-run 的預設 erp-tag-v2（F-3）。
--    既有列不改寫：0007 之前建立的 preview 該欄為 NULL，apply 視為「建立當時的 active 版本」。
--
-- 2. run_class_categories：D2 寫入「run 實際採用的類別」的表。D1 只建表，保持空表、不寫入任何列。
--    v1／v2 run 沒有列（＝沿用名稱映射）；run 刪除時連帶刪除。
--
-- 只加欄位與加表，不重寫、不搬移、不刪除任何既有資料（getDatabase() 首次讀取就會自動套用 migration，F-15）。

ALTER TABLE settings_previews ADD COLUMN target_rule_set_version TEXT;

CREATE TABLE IF NOT EXISTS run_class_categories (
  run_id TEXT NOT NULL,
  base_name TEXT NOT NULL,
  category TEXT NOT NULL,
  fixed_five_days INTEGER NOT NULL,
  mapped INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (run_id, base_name),
  FOREIGN KEY (run_id) REFERENCES calculation_runs (id) ON DELETE CASCADE
);
