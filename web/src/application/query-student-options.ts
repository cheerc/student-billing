import type Database from 'better-sqlite3';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { parseTagDiscounts } from '@/domain/billing/discount-rules';
import { normalizeStudentQuery, type QueryValue } from '@/contracts/student-query';
import { createStudentPredicateBuilder } from './student-query-predicates';
import { rateCategoryOfClass } from './applicable-rate';
import { historicalRuleSetMetadata } from '@/domain/billing/rule-set';
import { projectActionableIssues } from '@/domain/issues/actionable-issues';
import { ALLOWED_RUN_QUERY_PARAMS, validateRunQueryParams, QueryStudentError } from './query-students';

export interface StudentFilterOption { value: string; count: number; labelKey?: 'unparsedClassLabel' }
/** URL／內部篩選條件（wire 值的 partial record）；與 RunStudentQueryParams 同形但非查詢專用。 */
export type StudentFilterParams = Partial<Record<string, string[]>>;
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

/** 指定 run 的值宇宙；每欄 count 套其他已套用條件（排除自身），不受列表 limit/cursor 影響。 */
export function queryStudentOptions(db: Database.Database, runId: string, params: StudentFilterParams): RunStudentOptions {
  validateRunQueryParams(params);
  const query = normalizeStudentQuery(params, ALLOWED_RUN_QUERY_PARAMS);
  const run = getCalculationRun(db, runId);
  if (!run) throw new QueryStudentError(404, `找不到計算 run: ${runId}`);
  if (query.runId && query.runId !== runId) throw new QueryStudentError(400, 'runId 與路徑不符');
  const base = createStudentPredicateBuilder(db, runId, run.importId);
  const rows = db.prepare(`SELECT person_code, grade, branch, subject_count, base_discount_bps, anqin_days, tutoring_days,
    applicable_anqin_bps, applicable_tutoring_bps, applicable_math_bps, applicable_english_bps,
    has_issues, tier_mismatch, issues, tier_comparisons, trace FROM student_calculations WHERE run_id = ?`).all(runId) as any[];
  // 值宇宙＝全 run 的值；學生範圍＝其他欄已套用的條件（排除本欄，0人值仍回傳）。
  const scopeOf = (key: string) => {
    const { where } = base(query, key);
    return new Set((db.prepare(`SELECT sc.person_code FROM student_calculations sc WHERE ${where.sql}`).all(...where.args) as Array<{ person_code: string }>).map((row) => row.person_code));
  };
  const enrollments = db.prepare('SELECT person_code, base_name FROM student_enrollments WHERE import_id = ?').all(run.importId) as Array<{ person_code: string; base_name: string }>;
  const classNames = new Map<string, Set<string>>();
  for (const enrollment of enrollments) {
    const names = classNames.get(enrollment.person_code) ?? new Set<string>();
    names.add(enrollment.base_name);
    classNames.set(enrollment.person_code, names);
  }
  const selected = query.selections.enrollmentKey;
  const classKey = selected && !selected.none && selected.values.length === 1 && typeof selected.values[0] === 'string' ? selected.values[0] : null;

  // Ruling 3: 優先自 run.classCategories 快照讀取班級類別（非快照 run 才退回 rateCategoryOfClass）
  let category: 'care' | 'math' | 'english' | null = null;
  let isFixedFiveV3 = false;
  const runMetadata = historicalRuleSetMetadata(run.ruleSetVersion);
  const usesSnapshot = runMetadata.known && runMetadata.hasClassCategorySnapshot && Array.isArray(run.classCategories);

  if (classKey !== null) {
    if (usesSnapshot && run.classCategories) {
      const snap = run.classCategories.find((c) => c.base_name === classKey);
      if (snap) {
        if (runMetadata.fixedFiveDaysAffectsRate && snap.fixed_five_days === 1) {
          isFixedFiveV3 = true;
        }
        if (snap.category === 'care' || snap.category === 'math' || snap.category === 'english') {
          category = snap.category;
        }
      }
    } else if (runMetadata.known) {
      category = rateCategoryOfClass(classKey);
    }
  }

  const contextStatus: 'configured' | 'not_configured' | 'requires_class' =
    classKey === null
      ? 'requires_class'
      : isFixedFiveV3 || category !== null
        ? 'configured'
        : 'not_configured';

  const context: RunStudentOptions['applicableRateContext'] = {
    classKey: classKey === null ? null : wireValue(classKey),
    status: contextStatus,
  };
  const candidates = new Map<string, Map<string, QueryValue>>();
  for (const key of ['enrollmentKey', 'grade', 'branch', 'anqinDays', 'tutoringDays', 'baseDiscountBps', 'applicableDiscountBps', 'hasExtraDeduction', 'sibling', 'specialDiscount', 'internalStudent', 'hasIssues', 'issueCode', 'tierMismatch', 'tierComparison', 'hasClass']) candidates.set(key, new Map());
  const facetRows = new Map<string, Array<[string, string]>>([...candidates.keys()].map((key) => [key, []]));
  let currentPersonCode = '';
  const add = (key: string, values: QueryValue[]) => {
    const group = candidates.get(key)!;
    for (const value of values) {
      const wire = wireValue(value);
      group.set(wire, value);
      facetRows.get(key)!.push([currentPersonCode, wire]);
    }
  };
  let noCourseTotal = 0;
  for (const row of rows) {
    currentPersonCode = row.person_code;
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
    const comparisons = JSON.parse(row.tier_comparisons) as Array<{ status: string; needsReview?: boolean }>;
    const issues = JSON.parse(row.issues) as Array<{ code: string }>;
    const actionable = projectActionableIssues(issues, comparisons);
    add('hasIssues', [actionable.actionableHasIssues]);
    const hasMismatch = comparisons.some((c) => c.status === 'mismatch');
    // 值宇宙涵蓋任一班曾match者；全run的false人數可為0，選該match班後卻可能大於0。
    const hasMatch = comparisons.some((c) => c.status === 'match');
    const tierMismatchValues: boolean[] = [];
    if (hasMismatch) tierMismatchValues.push(true);
    if (hasMatch) tierMismatchValues.push(false);
    add('tierMismatch', tierMismatchValues);
    add('issueCode', actionable.actionableIssues.length ? actionable.actionableIssues.map((i) => i.code) : [null]);
    add('tierComparison', comparisons.length ? comparisons.map((c) => c.status) : [null]);
    const trace = JSON.parse(row.trace);
    const tags = parseTagDiscounts(trace.rawTags);
    add('sibling', [tags.sibling]);
    add('internalStudent', [tags.internalStudent]);
    add('specialDiscount', [tags.specialDiscount !== null]);
    add('hasExtraDeduction', [Boolean(trace.careDays?.anqin?.hasExtraFlag || trace.careDays?.tutoring?.hasExtraFlag)]);
    if (classKey && names?.has(classKey)) {
      if (contextStatus === 'configured') {
        const value = isFixedFiveV3
          ? 10000
          : category === 'care'
            ? row.grade === 1 || row.grade === 2
              ? row.applicable_anqin_bps
              : row.grade >= 3 && row.grade <= 6
                ? row.applicable_tutoring_bps
                : null
            : category === 'math'
              ? row.applicable_math_bps
              : row.applicable_english_bps;
        add('applicableDiscountBps', [value]);
      }
    } else if (classKey === null) {
      // 全量四欄的實際值；沒有恰選一班時不能拿這份集合當某班的適用率。
      add('applicableDiscountBps', [row.applicable_anqin_bps, row.applicable_tutoring_bps, row.applicable_math_bps, row.applicable_english_bps]);
    }
  }
  // 候選＋其餘已套用條件必須是合法的整體查詢；非法組合仍回值但 count=0
  // （既有 GET 400 契約不變；點不動的值不該顯示人數，-81）。
  const legal = (key: string, raw: QueryValue): boolean => {
    try {
      normalizeStudentQuery({ ...params, [key]: [wireValue(raw)] }, ALLOWED_RUN_QUERY_PARAMS);
      return true;
    } catch {
      return false;
    }
  };
  const options = Object.fromEntries([...candidates].map(([key, group]) => {
    // 一般欄每欄一次GROUP BY，不對每個候選值重掃run；仍由同源predicate定義其他欄範圍。
    // 班級候選會改變tierMismatch／applicable的取值context，這兩種情況須逐候選重建predicate。
    const contextual = key === 'tierMismatch' || (key === 'enrollmentKey' && Boolean(query.selections.tierMismatch || query.selections.applicableDiscountBps));
    const scoped = scopeOf(key);
    const pairs = facetRows.get(key)!.filter(([code, wire]) => scoped.has(code) && legal(key, group.get(wire)!));
    let counts = new Map<string, number>();
    if (!contextual) {
      const counted = db.prepare(`SELECT json_extract(f.value, '$[1]') AS value,
        COUNT(DISTINCT json_extract(f.value, '$[0]')) AS total FROM json_each(?) f
        GROUP BY json_extract(f.value, '$[1]')`).all(JSON.stringify(pairs)) as Array<{ value: string; total: number }>;
      counts = new Map(counted.map((row) => [row.value, row.total]));
    }
    return [key, [...group].sort(([a], [b]) => a.localeCompare(b)).map(([value, raw]) => {
      let count = counts.get(value) ?? 0;
      if (contextual && legal(key, raw)) {
        const { where } = base(query, key, { values: [raw], none: false });
        count = (db.prepare(`SELECT COUNT(DISTINCT sc.person_code) AS total FROM student_calculations sc WHERE ${where.sql}`).get(...where.args) as { total: number }).total;
      }
      return key === 'enrollmentKey' && value === '~empty' ? { value, count, labelKey: 'unparsedClassLabel' as const } : { value, count };
    })];
  }));
  return { runId, importId: run.importId, totalStudents: rows.length, noCourseTotal, options, applicableRateContext: context };
}
