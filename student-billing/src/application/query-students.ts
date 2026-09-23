import Database from 'better-sqlite3';
import { StudentCalculationRecord, getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { ParsedToken } from '@/domain/students';

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
}

export interface RunStudentsQueryResult {
  runId: string;
  items: StudentCalculationItem[];
  totalStudents: number;
  nextCursor: string | null;
  stats: {
    totalStudents: number;
    mismatchCount: number;
    issuesCount: number;
  };
}

export function validateRunQueryParams(params: Record<string, any>): void {
  for (const key of Object.keys(params)) {
    if (params[key] === undefined || params[key] === null || params[key] === '') {
      continue;
    }
    if (!ALLOWED_RUN_QUERY_PARAMS.has(key)) {
      throw new QueryStudentError(400, `未知或不支援的查詢參數: 「${key}」`);
    }
  }
}

export function queryRunStudents(
  db: Database.Database,
  runId: string,
  params: RunStudentQueryParams
): RunStudentsQueryResult {
  validateRunQueryParams(params);

  const run = getCalculationRun(db, runId);
  if (!run) {
    throw new QueryStudentError(404, `找不到計算 run: ${runId}`);
  }

  // 解析 limit
  let limit = 50;
  if (params.limit !== undefined) {
    const parsedLimit = parseInt(String(params.limit), 10);
    if (isNaN(parsedLimit) || parsedLimit <= 0) {
      throw new QueryStudentError(400, 'limit 必須為大於 0 之正整數');
    }
    limit = Math.min(200, parsedLimit);
  }

  // 解析 cursor
  let lastPersonCode: string | null = null;
  if (params.cursor) {
    try {
      const decoded = Buffer.from(params.cursor, 'base64').toString('utf-8');
      if (!decoded || !/^STU[0-9A-Za-z_-]+$/.test(decoded)) {
        throw new Error('invalid format');
      }
      lastPersonCode = decoded;
    } catch (_e) {
      throw new QueryStudentError(400, `無效的 cursor 參數: ${params.cursor}`);
    }
  }

  const whereClauses: string[] = ['sc.run_id = ?'];
  const queryArgs: any[] = [runId];

  // 1. 班級 / enrollmentKey
  const targetClass = params.enrollmentKey || params.classId;
  if (targetClass) {
    whereClauses.push(`
      EXISTS (
        SELECT 1 FROM student_enrollments e
        WHERE e.import_id = ? AND e.person_code = sc.person_code AND e.base_name = ?
      )
    `);
    queryArgs.push(run.importId, targetClass);
  }

  // 2. 年級
  if (params.grade !== undefined && params.grade !== '') {
    const gNum = parseInt(String(params.grade), 10);
    if (!isNaN(gNum)) {
      whereClauses.push('sc.grade = ?');
      queryArgs.push(gNum);
    }
  }

  // 3. tierMismatch 篩選
  if (params.tierMismatch !== undefined && params.tierMismatch !== '') {
    const isMismatch = params.tierMismatch === true || params.tierMismatch === 'true';
    whereClauses.push(`sc.tier_mismatch = ?`);
    queryArgs.push(isMismatch ? 1 : 0);
  }

  // 4. hasIssues 篩選
  if (params.hasIssues !== undefined && params.hasIssues !== '') {
    const hasIssues = params.hasIssues === true || params.hasIssues === 'true';
    whereClauses.push(`sc.has_issues = ?`);
    queryArgs.push(hasIssues ? 1 : 0);
  }

  // 5. 搜尋關鍵字
  if (params.q && params.q.trim()) {
    const term = `%${params.q.trim()}%`;
    whereClauses.push('(sc.name LIKE ? OR sc.person_code LIKE ?)');
    queryArgs.push(term, term);
  }

  const baseWhereSql = whereClauses.join(' AND ');

  // 統計總人數
  const totalRow = db
    .prepare(`SELECT COUNT(*) as total FROM student_calculations sc WHERE ${baseWhereSql}`)
    .get(...queryArgs) as { total: number };
  const totalStudents = totalRow ? totalRow.total : 0;

  // 統計 mismatch 人數
  const mismatchRow = db
    .prepare(`SELECT COUNT(*) as total FROM student_calculations sc WHERE ${baseWhereSql} AND sc.tier_mismatch = 1`)
    .get(...queryArgs) as { total: number };

  // 統計 issues 人數
  const issuesRow = db
    .prepare(`SELECT COUNT(*) as total FROM student_calculations sc WHERE ${baseWhereSql} AND sc.has_issues = 1`)
    .get(...queryArgs) as { total: number };

  // 分頁查詢
  const pagedWhere = [...whereClauses];
  const pagedArgs = [...queryArgs];

  if (lastPersonCode) {
    pagedWhere.push('sc.person_code > ?');
    pagedArgs.push(lastPersonCode);
  }

  pagedArgs.push(limit + 1);

  const sql = `
    SELECT sc.*, s.source_row
    FROM student_calculations sc
    LEFT JOIN imported_students s ON s.import_id = ? AND s.person_code = sc.person_code
    WHERE ${pagedWhere.join(' AND ')}
    ORDER BY sc.person_code ASC
    LIMIT ?
  `;

  const rows = db.prepare(sql).all(run.importId, ...pagedArgs) as any[];

  const hasNext = rows.length > limit;
  const itemRows = hasNext ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasNext && itemRows.length > 0) {
    nextCursor = Buffer.from(itemRows[itemRows.length - 1].person_code).toString('base64');
  }

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

  const items: StudentCalculationItem[] = itemRows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    personCode: r.person_code,
    name: r.name,
    branch: r.branch,
    grade: r.grade,
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
    trace: JSON.parse(r.trace),
    createdAt: r.created_at,
    enrollments: enrollmentsMap[r.person_code] || [],
    sourceRow: r.source_row ?? 0,
  }));

  return {
    runId,
    items,
    totalStudents,
    nextCursor,
    stats: {
      totalStudents,
      mismatchCount: mismatchRow ? mismatchRow.total : 0,
      issuesCount: issuesRow ? issuesRow.total : 0,
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
    sourceRow: row.source_row ?? 0,
  };
}
