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
  /** 班級全文：enrollments rawToken 依 token_index 升冪以換行拼回（不另立 DB 欄） */
  classText: string | null;
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

export const KNOWN_ISSUE_CODES = new Set([
  'DUPLICATE_SUBJECT_ENROLLMENT',
  'STAFF_FAMILY_NO_DISCOUNT',
  'CONFLICTING_NOTE_SOURCE',
  'NUMERIC_POLICY_DIFFERENCE',
  'SCHEDULE_NOT_FOUND',
  'SCHEDULE_EMPTY',
  'SCHEDULE_INCOMPLETE',
  'UNKNOWN_WEEKDAY',
]);

export const VALID_TIER_COMPARISONS = new Set([
  'match',
  'mismatch',
  'not_applicable',
  'unavailable',
]);

export function validateRunQueryParams(params: Record<string, any>): void {
  for (const key of Object.keys(params)) {
    if (params[key] === undefined || params[key] === null || params[key] === '') {
      continue;
    }
    if (!ALLOWED_RUN_QUERY_PARAMS.has(key)) {
      throw new QueryStudentError(400, `未知或不支援的查詢參數: 「${key}」`);
    }
  }

  // issueCode 檢驗
  if (params.issueCode !== undefined && params.issueCode !== '') {
    if (!KNOWN_ISSUE_CODES.has(String(params.issueCode))) {
      throw new QueryStudentError(400, `未知或不支援的問題碼: 「${params.issueCode}」`);
    }
    if (params.hasIssues === false || params.hasIssues === 'false') {
      throw new QueryStudentError(400, 'hasIssues=false 與 issueCode 不得同時指定');
    }
  }

  // tierComparison 檢驗與 tierMismatch 矛盾檢查
  if (params.tierComparison !== undefined && params.tierComparison !== '') {
    if (!VALID_TIER_COMPARISONS.has(String(params.tierComparison))) {
      throw new QueryStudentError(400, `無效的 tierComparison 參數值: 「${params.tierComparison}」`);
    }
    const isMismatchTrue = params.tierMismatch === true || params.tierMismatch === 'true';
    const isMismatchFalse = params.tierMismatch === false || params.tierMismatch === 'false';
    if (isMismatchTrue && params.tierComparison === 'match') {
      throw new QueryStudentError(400, 'tierMismatch=true 與 tierComparison=match 衝突矛盾');
    }
    if (isMismatchFalse && params.tierComparison === 'mismatch') {
      throw new QueryStudentError(400, 'tierMismatch=false 與 tierComparison=mismatch 衝突矛盾');
    }
  }

  // careType 與 billingTier 檢驗
  if (params.careType !== undefined && params.careType !== '') {
    if (params.careType !== 'anqin' && params.careType !== 'tutoring') {
      throw new QueryStudentError(400, `careType 僅接受 'anqin' 或 'tutoring'，無效值: 「${params.careType}」`);
    }
  }
  if (params.billingTier !== undefined && params.billingTier !== '') {
    if (!params.careType) {
      throw new QueryStudentError(400, '指定 billingTier 時必須同時指定 careType (anqin 或 tutoring)');
    }
    const tierNum = parseFloat(String(params.billingTier));
    if (isNaN(tierNum)) {
      throw new QueryStudentError(400, `無效的 billingTier 數值: 「${params.billingTier}」`);
    }
  }

  // applicableDiscountBps 檢驗 (需 classId)
  if (params.applicableDiscountBps !== undefined && params.applicableDiscountBps !== '') {
    if (!params.classId && !params.enrollmentKey) {
      throw new QueryStudentError(400, '指定 applicableDiscountBps 時必須同時指定 classId');
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

  // 6. issueCode 篩選
  if (params.issueCode) {
    whereClauses.push(`sc.issues LIKE '%"code":"' || ? || '"%'`);
    queryArgs.push(params.issueCode);
  }

  // 7. tierComparison 篩選
  if (params.tierComparison) {
    whereClauses.push(`sc.tier_comparisons LIKE '%"status":"' || ? || '"%'`);
    queryArgs.push(params.tierComparison);
  }

  // 8. branch 分校篩選（D3 Task 5: 換行複值集合語義——整值相等或換行邊界精確匹配，相容 CRLF/LF）
  if (params.branch) {
    const b = String(params.branch).trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    whereClauses.push(`(
      replace(replace(sc.branch, char(13)||char(10), char(10)), char(13), char(10)) = ?
      OR replace(replace(sc.branch, char(13)||char(10), char(10)), char(13), char(10)) LIKE ? ESCAPE '\\'
      OR replace(replace(sc.branch, char(13)||char(10), char(10)), char(13), char(10)) LIKE ? ESCAPE '\\'
      OR replace(replace(sc.branch, char(13)||char(10), char(10)), char(13), char(10)) LIKE ? ESCAPE '\\'
    )`);
    const esc = b.replace(/[\\%_]/g, (c) => '\\' + c);
    queryArgs.push(b, `${esc}\n%`, `%\n${esc}`, `%\n${esc}\n%`);
  }

  // 9. hasClass 有無班級篩選
  if (params.hasClass !== undefined && params.hasClass !== '') {
    const hasClassBool = params.hasClass === true || params.hasClass === 'true';
    if (hasClassBool) {
      whereClauses.push('sc.subject_count > 0');
    } else {
      whereClauses.push('(sc.subject_count = 0 OR sc.subject_count IS NULL)');
    }
  }

  // 10. billingTier + careType 篩選
  if (params.billingTier !== undefined && params.billingTier !== '') {
    const tierNum = parseFloat(String(params.billingTier));
    if (params.careType === 'anqin') {
      whereClauses.push('sc.anqin_days = ?');
      queryArgs.push(tierNum);
    } else if (params.careType === 'tutoring') {
      whereClauses.push('sc.tutoring_days = ?');
      queryArgs.push(tierNum);
    }
  }

  // 11. baseDiscountBps 基本折扣篩選
  if (params.baseDiscountBps !== undefined && params.baseDiscountBps !== '') {
    const bps = parseInt(String(params.baseDiscountBps), 10);
    if (!isNaN(bps)) {
      whereClauses.push('sc.base_discount_bps = ?');
      queryArgs.push(bps);
    }
  }

  // 12. subject 科別篩選
  if (params.subject) {
    whereClauses.push(`
      EXISTS (
        SELECT 1 FROM student_enrollments e
        WHERE e.import_id = ? AND e.person_code = sc.person_code
          AND (e.base_name LIKE '%' || ? || '%' OR e.raw_token LIKE '%' || ? || '%')
      )
    `);
    queryArgs.push(run.importId, params.subject, params.subject);
  }

  // 13. sibling, internalStudent
  if (params.sibling !== undefined && params.sibling !== '') {
    const isSib = params.sibling === true || params.sibling === 'true';
    if (isSib) {
      whereClauses.push(`EXISTS (SELECT 1 FROM imported_students s WHERE s.import_id = ? AND s.person_code = sc.person_code AND s.tags_raw LIKE '%有兄弟姊妹折扣%')`);
    } else {
      whereClauses.push(`NOT EXISTS (SELECT 1 FROM imported_students s WHERE s.import_id = ? AND s.person_code = sc.person_code AND s.tags_raw LIKE '%有兄弟姊妹折扣%')`);
    }
    queryArgs.push(run.importId);
  }

  if (params.internalStudent !== undefined && params.internalStudent !== '') {
    const isInternal = params.internalStudent === true || params.internalStudent === 'true';
    if (isInternal) {
      whereClauses.push(`EXISTS (SELECT 1 FROM imported_students s WHERE s.import_id = ? AND s.person_code = sc.person_code AND s.tags_raw LIKE '%園內生%')`);
    } else {
      whereClauses.push(`NOT EXISTS (SELECT 1 FROM imported_students s WHERE s.import_id = ? AND s.person_code = sc.person_code AND s.tags_raw LIKE '%園內生%')`);
    }
    queryArgs.push(run.importId);
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
    // D3 Task 4: 班級全文由 enrollments rawToken 依 token_index 升冪以換行拼回（正規化去除 \r）
    classText: enrollments.length > 0 ? enrollments.map((e) => e.rawToken.trim().replace(/\r\n/g, '').replace(/\r/g, '')).join('\n') : null,
    sourceRow: row.source_row ?? 0,
  };
}
