import Database from 'better-sqlite3';
import { StudentCalculationRecord, getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { ParsedToken } from '@/domain/students';
import { createStudentPredicateBuilder } from './student-query-predicates';
import { normalizeStudentQuery, StudentQueryInputError, queryIdentity, decodeStudentCursor, encodeStudentCursor, type NormalizedStudentQuery } from '@/contracts/student-query';
import { noCoursePredicate } from './student-query-sql';
import { projectActionableIssues } from '@/domain/issues/actionable-issues';

export class QueryStudentError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'QueryStudentError';
    this.statusCode = statusCode;
  }
}

export const ALLOWED_RUN_QUERY_PARAMS = new Set([
  'runId',
  'classId',
  'enrollmentKey',
  'subject',
  'grade',
  'branch',
  'hasClass',
  'q',
  'sort',
  'cursor',
  'limit',
  'baseDiscountBps',
  'applicableDiscountBps',
  'billingTier',
  'careType',
  'sibling',
  'specialDiscount',
  'internalStudent',
  'hasExtraDeduction',
  'tierMismatch',
  'tierComparison',
  'hasIssues',
  'scheduleStatus',
  'issueCode',
  'anqinDays',
  'tutoringDays',
  'options',
  'mappingStatus',
]);

export interface RunStudentQueryParams {
  classId?: string | string[];
  enrollmentKey?: string | string[];
  grade?: string | number | Array<string | number>;
  branch?: string | string[];
  hasClass?: boolean | string | Array<boolean | string>;
  q?: string;
  cursor?: string;
  limit?: number | string;
  tierMismatch?: boolean | string | Array<boolean | string>;
  hasIssues?: boolean | string | Array<boolean | string>;
  issueCode?: string | string[];
  [key: string]: any;
}

export interface StudentCalculationItem extends StudentCalculationRecord {
  enrollments: ParsedToken[];
  sourceRow: number;
  /** 班級全文：enrollments rawToken 依 token_index 升冪以換行拼回（不另立 DB 欄） */
  classText: string | null;
  /** Derived UI projection; the persisted `issues` and `hasIssues` remain raw historical values. */
  actionableIssues: any[];
  actionableHasIssues: boolean;
}

export interface RunStudentsQueryResult {
  runId: string;
  items: StudentCalculationItem[];
  totalStudents: number;
  noCourseTotal: number;
  nextCursor: string | null;
  stats: {
    /** 符合目前篩選條件的人數（同範圍） */
    totalStudents: number;
    mismatchCount: number;
    issuesCount: number;
    /**
     * 本班人數：僅套用班級（enrollmentKey／classId）條件後的人數，不含其他篩選條件。
     * 09 §5.1「本班N人 · 符合篩選M人 · N位需確認」中的「本班N人」——
     * 它的 scope 是「這個班」，不是「全部條件篩完的結果」。
     * 未選班時為全批人數。
     */
    classScopeTotal: number;
    filteredNoCourseCount: number;
  };
}

export { KNOWN_ISSUE_CODES, VALID_TIER_COMPARISONS } from '@/contracts/student-query';

function parseRunQuery(params: RunStudentQueryParams): NormalizedStudentQuery {
  try {
    return normalizeStudentQuery(params, ALLOWED_RUN_QUERY_PARAMS);
  } catch (error) {
    if (error instanceof StudentQueryInputError) throw new QueryStudentError(400, error.message);
    throw error;
  }
}

export function validateRunQueryParams(params: Record<string, any>): void {
  parseRunQuery(params);
}

export function queryRunStudents(db: Database.Database, runId: string, params: RunStudentQueryParams): RunStudentsQueryResult {
  const query = parseRunQuery(params);
  const run = getCalculationRun(db, runId);
  if (!run) throw new QueryStudentError(404, `找不到計算 run: ${runId}`);
  if (query.runId && query.runId !== runId) throw new QueryStudentError(400, 'runId 與路徑不符');
  const limit = query.limit;
  const identity = queryIdentity(`run:${runId}:import:${run.importId}`, query);
  let lastPersonCode: string | null;
  try { lastPersonCode = decodeStudentCursor(query.cursor, identity); }
  catch (error) { throw new QueryStudentError(400, (error as Error).message); }
  const selected = query.selections;
  const { where, classes, mismatch, issues } = createStudentPredicateBuilder(db, runId, run.importId)(query);
  const baseWhereSql = where.sql;
  const queryArgs = where.args;
  const noCourse = noCoursePredicate(run.importId, 'sc');
  const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM student_calculations sc WHERE ${baseWhereSql}`).get(...queryArgs) as { total: number };
  const totalStudents = totalRow.total;
  const mismatchRow = db.prepare(`SELECT COUNT(*) AS total FROM student_calculations sc WHERE ${baseWhereSql} AND ${mismatch.sql}`).get(...queryArgs, ...mismatch.args) as { total: number };
  const issuesRow = db.prepare(`SELECT COUNT(*) AS total FROM student_calculations sc WHERE ${baseWhereSql} AND ${issues.sql}`).get(...queryArgs, ...issues.args) as { total: number };
  const noCourseTotal = (db.prepare(`SELECT COUNT(*) AS total FROM student_calculations sc WHERE sc.run_id = ? AND ${noCourse.sql}`).get(runId, ...noCourse.args) as { total: number }).total;
  const filteredNoCourseCount = (db.prepare(`SELECT COUNT(*) AS total FROM student_calculations sc WHERE ${baseWhereSql} AND ${noCourse.sql}`).get(...queryArgs, ...noCourse.args) as { total: number }).total;
  const emptySelection = Object.values(selected).some((s) => s.none);
  const classScopeTotal = emptySelection ? 0 : (db.prepare(`SELECT COUNT(*) AS total FROM student_calculations sc WHERE sc.run_id = ? AND ${classes.sql}`).get(runId, ...classes.args) as { total: number }).total;
  const pagedWhere = [baseWhereSql];
  const pagedArgs = [...queryArgs];
  if (lastPersonCode) { pagedWhere.push('sc.person_code > ?'); pagedArgs.push(lastPersonCode); }
  pagedArgs.push(limit + 1);
  const rows = db.prepare(`SELECT sc.*, s.source_row FROM student_calculations sc LEFT JOIN imported_students s ON s.import_id = ? AND s.person_code = sc.person_code WHERE ${pagedWhere.join(' AND ')} ORDER BY sc.person_code ASC LIMIT ?`).all(run.importId, ...pagedArgs) as any[];
  const hasNext = rows.length > limit;
  const itemRows = hasNext ? rows.slice(0, limit) : rows;
  const nextCursor = hasNext && itemRows.length ? encodeStudentCursor(identity, itemRows[itemRows.length - 1].person_code) : null;

  // 查詢 enrollments
  const personCodes = itemRows.map((r) => r.person_code);
  const enrollmentsMap: Record<string, ParsedToken[]> = {};

  if (personCodes.length > 0) {
    const placeholders = personCodes.map(() => '?').join(',');
    const enrRows = db
      .prepare(`
        SELECT * FROM student_enrollments
        WHERE import_id = ? AND person_code IN (${placeholders})
        ORDER BY token_index ASC
      `)
      .all(run.importId, ...personCodes) as any[];

    for (const er of enrRows) {
      if (!enrollmentsMap[er.person_code]) {
        enrollmentsMap[er.person_code] = [];
      }
      enrollmentsMap[er.person_code].push({
        rawToken: er.raw_token,
        yearPrefix: er.year_prefix,
        baseName: er.base_name,
        groupFlag: er.group_flag,
        modifiers: er.modifiers ? JSON.parse(er.modifiers) : [],
        withdrawalDate: er.withdrawal_date,
        erpBillingTierRaw: er.erp_billing_tier_raw,
        erpBillingTier: er.erp_billing_tier,
        tierParseStatus: er.tier_parse_status,
        parseStatus: er.parse_status,
      });
    }
  }

  const items: StudentCalculationItem[] = itemRows.map((r) => {
    const itemEnrollments = enrollmentsMap[r.person_code] || [];
    const tierComparisons = JSON.parse(r.tier_comparisons);
    const issues = JSON.parse(r.issues);
    const actionable = projectActionableIssues(issues, tierComparisons);
    return {
    id: r.id,
    runId: r.run_id,
    personCode: r.person_code,
    name: r.name,
    branch: r.branch,    grade: r.grade,
    gradeRaw: r.grade_raw,
    subjectCount: r.subject_count,
    baseDiscountBps: r.base_discount_bps,
    anqinDays: r.anqin_days,
    anqinDisplay: r.anqin_display,
    tutoringDays: r.tutoring_days,
    tutoringDisplay: r.tutoring_display,
    englishDays: r.english_days,
    mathDays: r.math_days,
    chineseDays: r.chinese_days,
    homeworkDays: r.homework_days,
    intensiveEnglishDays: r.intensive_english_days,
    saturdayTutoringDays: r.saturday_tutoring_days,
    applicableAnqinBps: r.applicable_anqin_bps,
    applicableTutoringBps: r.applicable_tutoring_bps,
    applicableEnglishBps: r.applicable_english_bps,
    applicableMathBps: r.applicable_math_bps,
    tierMismatch: Boolean(r.tier_mismatch),
    tierComparisons,
    issues,
    hasIssues: Boolean(r.has_issues),
    ...actionable,
    trace: (() => {
      const t = JSON.parse(r.trace);
      // D3 Task 5: 列表脫敏——備註全文不進列表，僅保留 hasNotes 布林；完整原文由明細端點按需查閱
      const rawNotes = t?.rawNotes ?? null;
      const { rawNotes: _dropped, ...rest } = t ?? {};
      return { ...rest, hasNotes: rawNotes !== null && String(rawNotes).trim() !== '' };
    })(),
    createdAt: r.created_at,
    enrollments: itemEnrollments,
    // D3 Task 4: 班級全文由 enrollments rawToken 依 token_index 升冪以換行拼回（正規化去除 \r）
    classText: itemEnrollments.length > 0 ? itemEnrollments.map((e) => e.rawToken.trim().replace(/\r\n/g, '').replace(/\r/g, '')).join('\n') : null,
    sourceRow: r.source_row ?? 0,
  };});

  return {
    runId,
    items,
    totalStudents,
    nextCursor,
    noCourseTotal,
    stats: {
      totalStudents,
      mismatchCount: mismatchRow ? mismatchRow.total : 0,
      issuesCount: issuesRow ? issuesRow.total : 0,
      classScopeTotal,
      filteredNoCourseCount,
    },
  };
}

export function getStudentCalculationDetail(
  db: Database.Database,
  runId: string,
  personCode: string
): StudentCalculationItem | null {
  const run = getCalculationRun(db, runId);
  if (!run) return null;

  const row = db
    .prepare(`
      SELECT sc.*, s.source_row
      FROM student_calculations sc
      LEFT JOIN imported_students s ON s.import_id = ? AND s.person_code = sc.person_code
      WHERE sc.run_id = ? AND sc.person_code = ?
    `)
    .get(run.importId, runId, personCode) as any;

  if (!row) return null;

  const enrRows = db
    .prepare(`
      SELECT * FROM student_enrollments
      WHERE import_id = ? AND person_code = ?
      ORDER BY token_index ASC
    `)
    .all(run.importId, personCode) as any[];

  const enrollments: ParsedToken[] = enrRows.map((er) => ({
    rawToken: er.raw_token,
    yearPrefix: er.year_prefix,
    baseName: er.base_name,
    groupFlag: er.group_flag,
    modifiers: er.modifiers ? JSON.parse(er.modifiers) : [],
    withdrawalDate: er.withdrawal_date,
    erpBillingTierRaw: er.erp_billing_tier_raw,
    erpBillingTier: er.erp_billing_tier,
    tierParseStatus: er.tier_parse_status,
    parseStatus: er.parse_status,
  }));

  const tierComparisons = JSON.parse(row.tier_comparisons);
  const issues = JSON.parse(row.issues);
  const actionable = projectActionableIssues(issues, tierComparisons);

  return {
    id: row.id,
    runId: row.run_id,
    personCode: row.person_code,
    name: row.name,
    branch: row.branch,
    grade: row.grade,
    gradeRaw: row.grade_raw,
    subjectCount: row.subject_count,
    baseDiscountBps: row.base_discount_bps,
    anqinDays: row.anqin_days,
    anqinDisplay: row.anqin_display,
    tutoringDays: row.tutoring_days,
    tutoringDisplay: row.tutoring_display,
    englishDays: row.english_days,
    mathDays: row.math_days,
    chineseDays: row.chinese_days,
    homeworkDays: row.homework_days,
    intensiveEnglishDays: row.intensive_english_days,
    saturdayTutoringDays: row.saturday_tutoring_days,
    applicableAnqinBps: row.applicable_anqin_bps,
    applicableTutoringBps: row.applicable_tutoring_bps,
    applicableEnglishBps: row.applicable_english_bps,
    applicableMathBps: row.applicable_math_bps,
    tierMismatch: Boolean(row.tier_mismatch),
    tierComparisons,
    issues,
    hasIssues: Boolean(row.has_issues),
    ...actionable,
    trace: JSON.parse(row.trace),
    createdAt: row.created_at,
    enrollments,
    // D3 Task 4: 班級全文由 enrollments rawToken 依 token_index 升冪以換行拼回（正規化去除 \r）
    classText: enrollments.length > 0 ? enrollments.map((e) => e.rawToken.trim().replace(/\r\n/g, '').replace(/\r/g, '')).join('\n') : null,
    sourceRow: row.source_row ?? 0,
  };
}
