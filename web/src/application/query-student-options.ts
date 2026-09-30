import type Database from 'better-sqlite3';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { parseTagDiscounts } from '@/domain/billing/discount-rules';
import { normalizeStudentQuery } from '@/contracts/student-query';
import { ALLOWED_RUN_QUERY_PARAMS, validateRunQueryParams, QueryStudentError, type RunStudentQueryParams } from './query-students';

export interface StudentFilterOption { value: string; count: number; labelKey?: 'unparsedClassLabel' }
export interface RunStudentOptions {
  runId: string;
  importId: string;
  totalStudents: number;
  noCourseTotal: number;
  options: Record<string, StudentFilterOption[]>;
  applicableRateContext: { classKey: string | null; status: 'configured' | 'not_configured' | 'requires_class' };
}

function wireValue(value: string | number | boolean | null): string {
  if (value === null) return '~blank';
  if (value === '') return '~empty';
  const text = String(value);
  return text.startsWith('~') ? '~' + text : text;
}

/** 指定 run 全量 read model；不讀 active pointer、最新設定、姓名或代碼選項，也不受列表 filters/limit 影響。 */
export function queryStudentOptions(db: Database.Database, runId: string, params: RunStudentQueryParams): RunStudentOptions {
  validateRunQueryParams(params);
  const query = normalizeStudentQuery(params, ALLOWED_RUN_QUERY_PARAMS);
  const run = getCalculationRun(db, runId);
  if (!run) throw new QueryStudentError(404, `找不到計算 run: ${runId}`);
  if (query.runId && query.runId !== runId) throw new QueryStudentError(400, 'runId 與路徑不符');
  const rows = db.prepare(`SELECT person_code, grade, branch, subject_count, base_discount_bps, anqin_days, tutoring_days,
    applicable_anqin_bps, applicable_tutoring_bps, applicable_math_bps, applicable_english_bps,
    has_issues, tier_mismatch, issues, tier_comparisons, trace FROM student_calculations WHERE run_id = ?`).all(runId) as any[];
  const enrollments = db.prepare('SELECT person_code, base_name FROM student_enrollments WHERE import_id = ?').all(run.importId) as Array<{ person_code: string; base_name: string }>;
  const classNames = new Map<string, Set<string>>();
  for (const enrollment of enrollments) {
    const names = classNames.get(enrollment.person_code) ?? new Set<string>();
    names.add(enrollment.base_name);
    classNames.set(enrollment.person_code, names);
  }
  const selected = query.selections.enrollmentKey;
  const classKey = selected && !selected.none && selected.values.length === 1 && typeof selected.values[0] === 'string' ? selected.values[0] : null;
  const category = classKey?.includes('國小輔導') ? 'care' : classKey?.includes('國小數學') ? 'math' : classKey?.includes('兒童美語') ? 'english' : null;
  const context: RunStudentOptions['applicableRateContext'] = { classKey: classKey === null ? null : wireValue(classKey), status: classKey === null ? 'requires_class' : category ? 'configured' : 'not_configured' };
  const counts = new Map<string, Map<string, number>>();
  for (const key of ['enrollmentKey', 'grade', 'branch', 'anqinDays', 'tutoringDays', 'baseDiscountBps', 'applicableDiscountBps', 'hasExtraDeduction', 'sibling', 'specialDiscount', 'internalStudent', 'hasIssues', 'issueCode', 'tierMismatch', 'tierComparison', 'hasClass']) counts.set(key, new Map());
  const add = (key: string, values: Array<string | number | boolean | null>) => {
    const group = counts.get(key)!;
    for (const value of new Set(values.map(wireValue))) group.set(value, (group.get(value) ?? 0) + 1);
  };
  let noCourseTotal = 0;
  for (const row of rows) {
    const names = classNames.get(row.person_code);
    if (!names?.size) noCourseTotal++;
    add('enrollmentKey', names?.size ? [...names] : [null]);
    add('grade', [row.grade]);
    const branches = row.branch ? String(row.branch).replace(/\r\n?/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean) : [];
    add('branch', branches.length ? branches : [null]);
    add('anqinDays', [row.anqin_days]);
    add('tutoringDays', [row.tutoring_days]);
    add('baseDiscountBps', [row.base_discount_bps]);
    add('hasClass', [(row.subject_count ?? 0) > 0]);
    add('hasIssues', [Boolean(row.has_issues)]);
    add('tierMismatch', [Boolean(row.tier_mismatch)]);
    const issues = JSON.parse(row.issues) as Array<{ code: string }>;
    const comparisons = JSON.parse(row.tier_comparisons) as Array<{ status: string }>;
    add('issueCode', issues.length ? issues.map((i) => i.code) : [null]);
    add('tierComparison', comparisons.length ? comparisons.map((c) => c.status) : [null]);
    const trace = JSON.parse(row.trace);
    const tags = parseTagDiscounts(trace.rawTags);
    add('sibling', [tags.sibling]);
    add('internalStudent', [tags.internalStudent]);
    add('specialDiscount', [tags.specialDiscount !== null]);
    add('hasExtraDeduction', [Boolean(trace.careDays?.anqin?.hasExtraFlag || trace.careDays?.tutoring?.hasExtraFlag)]);
    if (classKey && category && names?.has(classKey)) {
      const value = category === 'care'
        ? row.grade === 1 || row.grade === 2 ? row.applicable_anqin_bps : row.grade >= 3 && row.grade <= 6 ? row.applicable_tutoring_bps : null
        : category === 'math' ? row.applicable_math_bps : row.applicable_english_bps;
      add('applicableDiscountBps', [value]);
    } else if (classKey === null) {
      // 全量四欄的實際值；沒有恰選一班時不能拿這份集合當某班的適用率。
      add('applicableDiscountBps', [row.applicable_anqin_bps, row.applicable_tutoring_bps, row.applicable_math_bps, row.applicable_english_bps]);
    }
  }
  const options = Object.fromEntries([...counts].map(([key, group]) => [key,
    [...group].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) =>
      key === 'enrollmentKey' && value === '~empty' ? { value, count, labelKey: 'unparsedClassLabel' as const } : { value, count }),
  ]));
  return { runId, importId: run.importId, totalStudents: rows.length, noCourseTotal, options, applicableRateContext: context };
}
