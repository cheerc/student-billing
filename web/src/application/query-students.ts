import Database from 'better-sqlite3';
import { StudentCalculationRecord, getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { ParsedToken } from '@/domain/students';
import { parseTagDiscounts } from '@/domain/billing/discount-rules';
import { normalizeStudentQuery, StudentQueryInputError, queryIdentity, decodeStudentCursor, encodeStudentCursor, type NormalizedStudentQuery } from '@/contracts/student-query';
import { selectionPredicate, classPredicate, branchPredicate, noCoursePredicate, applicableRateColumn, escapeLike, type QueryPredicate } from './student-query-sql';

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
  classId?: string;
  enrollmentKey?: string;
  grade?: string | number;
  branch?: string;
  hasClass?: boolean | string;
  q?: string;
  cursor?: string;
  limit?: number | string;
  tierMismatch?: boolean | string;
  hasIssues?: boolean | string;
  issueCode?: string;
  [key: string]: any;
}

export interface StudentCalculationItem extends StudentCalculationRecord {
  enrollments: ParsedToken[];
  sourceRow: number;
  /** 班級全文：enrollments rawToken 依 token_index 升冪以換行拼回（不另立 DB 欄） */
  classText: string | null;
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
  const whereClauses = ['sc.run_id = ?'];
  const queryArgs: Array<string | number> = [runId];
  const add = (predicate: QueryPredicate) => {
    whereClauses.push(predicate.sql);
    queryArgs.push(...predicate.args);
  };
  const selected = query.selections;
  const classes = classPredicate(run.importId, 'sc', selected.enrollmentKey);
  add(classes);
  for (const [key, column] of Object.entries({
    grade: 'sc.grade', baseDiscountBps: 'sc.base_discount_bps', anqinDays: 'sc.anqin_days', tutoringDays: 'sc.tutoring_days',
    hasIssues: 'sc.has_issues', tierMismatch: 'sc.tier_mismatch',
  })) add(selectionPredicate(selected[key], column));
  add(branchPredicate('sc.branch', selected.branch));
  add(selectionPredicate(selected.hasClass, '(coalesce(sc.subject_count,0) > 0)', '0'));
  if (selected.billingTier) add(selectionPredicate(selected.billingTier, query.careType === 'anqin' ? 'sc.anqin_days' : 'sc.tutoring_days'));
  if (selected.applicableDiscountBps) {
    const target = String(selected.enrollmentKey.values[0]);
    const column = applicableRateColumn(target);
    add(column ? selectionPredicate(selected.applicableDiscountBps, column) : { sql: '0', args: [] });
  }
  if (query.q) {
    whereClauses.push("(sc.name LIKE ? ESCAPE '\\' OR sc.person_code LIKE ? ESCAPE '\\')");
    queryArgs.push(`%${escapeLike(query.q)}%`, `%${escapeLike(query.q)}%`);
  }
  if (query.subject) {
    whereClauses.push("EXISTS (SELECT 1 FROM student_enrollments e WHERE e.import_id = ? AND e.person_code = sc.person_code AND (e.base_name LIKE ? ESCAPE '\\' OR e.raw_token LIKE ? ESCAPE '\\'))");
    queryArgs.push(run.importId, `%${escapeLike(query.subject)}%`, `%${escapeLike(query.subject)}%`);
  }
  for (const [key, column, source] of [
    ['issueCode', "json_extract(j.value, '$.code')", 'sc.issues'],
    ['tierComparison', "json_extract(j.value, '$.status')", 'sc.tier_comparisons'],
  ]) {
    const group = selected[key];
    if (!group) continue;
    if (group.none) { add({ sql: '0', args: [] }); continue; }
    const parts: string[] = [];
    const args: Array<string | number> = [];
    for (const value of group.values) {
      if (value === null) parts.push(`json_array_length(${source}) = 0`);
      else {
        parts.push(`EXISTS (SELECT 1 FROM json_each(${source}) j WHERE ${column} = ?)`);
        args.push(String(value));
      }
    }
    add({ sql: `(${parts.join(' OR ')})`, args });
  }
  for (const [key, tag] of [['sibling', '有兄弟姊妹折扣'], ['internalStudent', '園內生']]) {
    const column = `EXISTS (SELECT 1 FROM imported_students s WHERE s.import_id = '${run.importId.replace(/'/g, "''")}' AND s.person_code = sc.person_code AND instr(s.tags_raw, '${tag}') > 0)`;
    add(selectionPredicate(selected[key], column, '0'));
  }
  // 額外扣天與結果表同源：讀已持久化的 hasExtraFlag，不以天數是否為 0 推測。
  add(selectionPredicate(selected.hasExtraDeduction,
    "(coalesce(json_extract(sc.trace, '$.careDays.anqin.hasExtraFlag'),0) OR coalesce(json_extract(sc.trace, '$.careDays.tutoring.hasExtraFlag'),0))", '0'));
  if (selected.specialDiscount) {
    const tagged = db.prepare('SELECT person_code, trace FROM student_calculations WHERE run_id = ?').all(runId) as Array<{ person_code: string; trace: string }>;
    const codes = tagged.filter((row) => parseTagDiscounts(JSON.parse(row.trace).rawTags).specialDiscount !== null).map((row) => row.person_code);
    const hasSpecial = codes.length ? `sc.person_code IN (${codes.map(() => '?').join(',')})` : '0';
    const terms: string[] = [];
    const args: Array<string | number> = [];
    if (selected.specialDiscount.none) terms.push('0');
    for (const value of selected.specialDiscount.values) {
      if (value === null) { terms.push('0'); continue; }
      terms.push(value ? `(${hasSpecial})` : `NOT (${hasSpecial})`);
      args.push(...codes);
    }
    add({ sql: `(${terms.join(' OR ')})`, args });
  }
  const baseWhereSql = whereClauses.join(' AND ');
  const noCourse = noCoursePredicate(run.importId, 'sc');
  const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM student_calculations sc WHERE ${baseWhereSql}`).get(...queryArgs) as { total: number };
  const totalStudents = totalRow.total;
  const mismatchRow = db.prepare(`SELECT COUNT(*) AS total FROM student_calculations sc WHERE ${baseWhereSql} AND sc.tier_mismatch = 1`).get(...queryArgs) as { total: number };
  const issuesRow = db.prepare(`SELECT COUNT(*) AS total FROM student_calculations sc WHERE ${baseWhereSql} AND sc.has_issues = 1`).get(...queryArgs) as { total: number };
  const noCourseTotal = (db.prepare(`SELECT COUNT(*) AS total FROM student_calculations sc WHERE sc.run_id = ? AND ${noCourse.sql}`).get(runId, ...noCourse.args) as { total: number }).total;
  const filteredNoCourseCount = (db.prepare(`SELECT COUNT(*) AS total FROM student_calculations sc WHERE ${baseWhereSql} AND ${noCourse.sql}`).get(...queryArgs, ...noCourse.args) as { total: number }).total;
  const emptySelection = Object.values(selected).some((s) => s.none);
  const classScopeTotal = emptySelection ? 0 : (db.prepare(`SELECT COUNT(*) AS total FROM student_calculations sc WHERE sc.run_id = ? AND ${classes.sql}`).get(runId, ...classes.args) as { total: number }).total;
  const pagedWhere = [...whereClauses];
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
    tierComparisons: JSON.parse(r.tier_comparisons),
    issues: JSON.parse(r.issues),
    hasIssues: Boolean(r.has_issues),
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
    tierComparisons: JSON.parse(row.tier_comparisons),
    issues: JSON.parse(row.issues),
    hasIssues: Boolean(row.has_issues),
    trace: JSON.parse(row.trace),
    createdAt: row.created_at,
    enrollments,
    // D3 Task 4: 班級全文由 enrollments rawToken 依 token_index 升冪以換行拼回（正規化去除 \r）
    classText: enrollments.length > 0 ? enrollments.map((e) => e.rawToken.trim().replace(/\r\n/g, '').replace(/\r/g, '')).join('\n') : null,
    sourceRow: row.source_row ?? 0,
  };
}
