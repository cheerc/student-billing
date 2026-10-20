import Database from 'better-sqlite3';
import { loadRunClassCategories, type RunClassCategorySnapshot } from '@/application/applicable-rate';
import { ruleSetCapabilities } from '@/domain/billing/rule-set';

export interface CalculationRunRecord {
  id: string;
  importId: string;
  scheduleVersionId: string;
  ruleSetVersion: string;
  numericPolicy: string;
  asOfDate: string;
  status: 'calculating' | 'completed';
  issueCounts: Record<string, number>;
  totalStudents: number;
  createdAt: string;
  /**
   * 該 run 的類別快照（03 §5.3.4；issue #122）。
   *
   * 三態，語意互不相同，**不可互相取代**：
   *  - `undefined`：此 run 沒有快照概念（v1／v2）→ 讀模型走當前班名映射。
   *  - `[]`：是 v3 run，但沒有任何快照列 → 讀模型一律 `not_configured`（嚴禁以班名猜測）。
   *  - 有值：v3 run 的實際採用類別，讀模型以快照為準。
   *
   * 形狀即 `RunClassCategorySnapshot`（底線命名、`fixed_five_days` 為數字 0/1）——
   * 與 `applicableRateForClass` 的輸入同形，消費端不得自行轉型。
   */
  classCategories?: RunClassCategorySnapshot[];
}

export interface StudentCalculationRecord {
  id: string;
  runId: string;
  personCode: string;
  name: string;
  branch: string | null;
  grade: number | null;
  gradeRaw: string | null;
  subjectCount: number | null;
  baseDiscountBps: number | null;
  anqinDays: number | null;
  anqinDisplay: string | null;
  tutoringDays: number | null;
  tutoringDisplay: string | null;
  englishDays: number | null;
  mathDays: number | null;
  chineseDays: number | null;
  homeworkDays: number | null;
  intensiveEnglishDays: number | null;
  saturdayTutoringDays: number | null;
  applicableAnqinBps: number | null;
  applicableTutoringBps: number | null;
  applicableEnglishBps: number | null;
  applicableMathBps: number | null;
  tierMismatch: boolean;
  tierComparisons: any[];
  issues: any[];
  hasIssues: boolean;
  trace: any;
  createdAt: string;
}

export interface RunClassCategoryRecord {
  baseName: string;
  category: string;
  fixedFiveDays: number;
  mapped: number;
  source: string;
}

export function saveCalculationRun(
  db: Database.Database,
  run: CalculationRunRecord,
  results: StudentCalculationRecord[],
  classCategories?: RunClassCategoryRecord[]
): void {
  const insertRun = db.prepare(`
    INSERT INTO calculation_runs (
      id, import_id, schedule_version_id, rule_set_version, numeric_policy,
      as_of_date, status, issue_counts, total_students, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertRun.run(
    run.id,
    run.importId,
    run.scheduleVersionId,
    run.ruleSetVersion,
    run.numericPolicy,
    run.asOfDate,
    run.status,
    JSON.stringify(run.issueCounts),
    run.totalStudents,
    run.createdAt
  );

  const insertResult = db.prepare(`
    INSERT INTO student_calculations (
      id, run_id, person_code, name, branch, grade, grade_raw,
      subject_count, base_discount_bps, anqin_days, anqin_display,
      tutoring_days, tutoring_display, english_days, math_days,
      chinese_days, homework_days, intensive_english_days, saturday_tutoring_days,
      applicable_anqin_bps, applicable_tutoring_bps, applicable_english_bps, applicable_math_bps,
      tier_mismatch, tier_comparisons, issues, has_issues, trace, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of results) {
    insertResult.run(
      r.id,
      r.runId,
      r.personCode,
      r.name,
      r.branch,
      r.grade,
      r.gradeRaw,
      r.subjectCount,
      r.baseDiscountBps,
      r.anqinDays,
      r.anqinDisplay,
      r.tutoringDays,
      r.tutoringDisplay,
      r.englishDays,
      r.mathDays,
      r.chineseDays,
      r.homeworkDays,
      r.intensiveEnglishDays,
      r.saturdayTutoringDays,
      r.applicableAnqinBps,
      r.applicableTutoringBps,
      r.applicableEnglishBps,
      r.applicableMathBps,
      r.tierMismatch ? 1 : 0,
      JSON.stringify(r.tierComparisons),
      JSON.stringify(r.issues),
      r.hasIssues ? 1 : 0,
      JSON.stringify(r.trace),
      r.createdAt
    );
  }

  // R2-1: 類別快照持久化 (categoryBasedBilling)，置於 calculation_runs 確定存在後執行，避免級聯刪除
  if (ruleSetCapabilities(run.ruleSetVersion).categoryBasedBilling && classCategories && classCategories.length > 0) {
    const insertCategory = db.prepare(`
      INSERT OR REPLACE INTO run_class_categories (
        run_id, base_name, category, fixed_five_days, mapped, source
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const item of classCategories) {
      insertCategory.run(
        run.id,
        item.baseName,
        item.category,
        item.fixedFiveDays,
        item.mapped,
        item.source
      );
    }
  }
}

export function getCalculationRun(
  db: Database.Database,
  runId: string
): CalculationRunRecord | null {
  const row = db.prepare('SELECT * FROM calculation_runs WHERE id = ?').get(runId) as any;
  if (!row) return null;

  const record: CalculationRunRecord = {
    id: row.id,
    importId: row.import_id,
    scheduleVersionId: row.schedule_version_id,
    ruleSetVersion: row.rule_set_version,
    numericPolicy: row.numeric_policy,
    asOfDate: row.as_of_date,
    status: row.status,
    issueCounts: JSON.parse(row.issue_counts),
    totalStudents: row.total_students,
    createdAt: row.created_at,
  };

  // issue #122：v3 run 的類別快照必須由**載入層**帶出，而非各 route 自行補查。
  // 只在這裡載入，`GET /api/v1/runs/{id}`、`/api/v1/runs/current`、`/api/v1/classes`
  // 等所有消費端才不會各自補一次而漂移。
  //
  // 判定用能力旗標而非字面比較（03 §5.3.1 禁止 `=== 'erp-tag-v3'`）：
  // v3 但零列必須是 `[]`，否則讀模型會退回當前班名映射，
  // 正是 03 §5.3.4 明文禁止的猜測。v1／v2 沒有快照概念，維持 `undefined`。
  if (ruleSetCapabilities(record.ruleSetVersion).categoryBasedBilling) {
    record.classCategories = loadRunClassCategories(db, runId);
  }

  return record;
}

export function getCurrentActiveRun(
  db: Database.Database
): { revision: number; activeImportId: string | null; activeRunId: string | null; run: CalculationRunRecord | null } {
  const state = db.prepare('SELECT * FROM active_state WHERE id = 1').get() as any;
  if (!state || !state.active_run_id) {
    return {
      revision: state ? state.revision : 0,
      activeImportId: state ? state.active_import_id : null,
      activeRunId: null,
      run: null,
    };
  }

  const run = getCalculationRun(db, state.active_run_id);
  return {
    revision: state.revision,
    activeImportId: state.active_import_id,
    activeRunId: state.active_run_id,
    run,
  };
}
