import Database from 'better-sqlite3';
import { loadRunClassCategories, type RunClassCategorySnapshot } from '@/application/applicable-rate';

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
   * 該 run 的單一類別快照（03 §5.3.4；run_class_categories）。
   * `[]`＝該 run 沒有任何快照列 → 讀模型一律 `not_configured`（嚴禁以班名猜測）。
   * 形狀即 `RunClassCategorySnapshot`（底線命名、`fixed_five_days` 為數字 0/1），消費端不得自行轉型。
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
  resolvedBaseName?: string | null;
  classType?: 'care' | 'non_care' | string | null;
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
  const persist = db.transaction(() => {
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

  // 類別快照持久化，置於 calculation_runs 確定存在後執行，避免級聯刪除
  if (classCategories && classCategories.length > 0) {
    const insertCategory = db.prepare(`
      INSERT OR REPLACE INTO run_class_categories (
        run_id, base_name, resolved_base_name, class_type, category, fixed_five_days, mapped, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of classCategories) {
      insertCategory.run(
        run.id,
        item.baseName,
        item.resolvedBaseName ?? item.baseName,
        item.classType ?? null,
        item.category,
        item.fixedFiveDays,
        item.mapped,
        item.source
      );
    }
  }

  });
  persist();
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

  // 類別快照由載入層統一帶出（/runs/{id}、/runs/current、/classes 共用同一讀模型），各 route 不自行補查。
  if (record.ruleSetVersion !== 'erp-tag-v1' && record.ruleSetVersion !== 'erp-tag-v2') {
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
