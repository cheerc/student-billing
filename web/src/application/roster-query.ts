import Database from 'better-sqlite3';
import { StudentSnapshot, ParsedToken } from '@/domain/students';

export class RosterQueryError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'RosterQueryError';
    this.statusCode = statusCode;
  }
}

export const ALLOWED_IMPORT_QUERY_PARAMS = new Set([
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
  'erpBillingTier',
  'mappingStatus',
]);

export const FORBIDDEN_CALCULATION_PARAMS = new Set([
  'runId',
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

export interface RosterQueryParams {
  classId?: string;
  enrollmentKey?: string;
  subject?: string;
  grade?: string | number;
  branch?: string;
  hasClass?: boolean | string;
  q?: string;
  sort?: string;
  cursor?: string;
  limit?: number | string;
  erpBillingTier?: number | string;
  mappingStatus?: string;
  [key: string]: any;
}

export interface RosterQueryResult {
  items: StudentSnapshot[];
  totalStudents: number;
  nextCursor: string | null;
  stats: {
    totalStudents: number;
    studentsWithClass: number;
    studentsWithoutClass: number;
  };
}

/**
 * 驗證傳入之查詢參數是否符合 03 §5 預覽名單白名單規範。
 */
export function validateImportQueryParams(params: Record<string, any>): void {
  for (const key of Object.keys(params)) {
    if (params[key] === undefined || params[key] === null || params[key] === '') {
      continue;
    }

    if (FORBIDDEN_CALCULATION_PARAMS.has(key)) {
      throw new RosterQueryError(
        400,
        `參數「${key}」為正式計算 run 專屬參數，預覽名單查詢不支援此參數。`
      );
    }

    if (!ALLOWED_IMPORT_QUERY_PARAMS.has(key)) {
      throw new RosterQueryError(400, `未知或不支援的查詢參數: 「${key}」`);
    }
  }
}

/**
 * 查詢指定 importId 之名單，支援關鍵字、年級、班級、有無班級等條件與 cursor 分頁。
 */
export function queryImportStudents(
  db: Database.Database,
  importId: string,
  params: RosterQueryParams
): RosterQueryResult {
  validateImportQueryParams(params);

  // 解析 limit (預設 50，最大 200)
  let limit = 50;
  if (params.limit !== undefined) {
    const parsedLimit = parseInt(String(params.limit), 10);
    if (isNaN(parsedLimit) || parsedLimit <= 0) {
      throw new RosterQueryError(400, 'limit 必須為大於 0 之正整數');
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
      throw new RosterQueryError(400, `無效的 cursor 參數: ${params.cursor}`);
    }
  }

  // 建立查詢過濾條件
  const whereClauses: string[] = ['s.import_id = ?'];
  const queryArgs: any[] = [importId];

  // 1. 班級 / enrollmentKey (baseName 精確匹配)
  const targetClassKey = params.enrollmentKey || params.classId;
  if (targetClassKey) {
    whereClauses.push(
      `EXISTS (SELECT 1 FROM student_enrollments e WHERE e.import_id = s.import_id AND e.person_code = s.person_code AND e.base_name = ?)`
    );
    queryArgs.push(targetClassKey);
  }

  // 2. 年級
  if (params.grade !== undefined && params.grade !== '') {
    const gNum = parseInt(String(params.grade), 10);
    if (!isNaN(gNum)) {
      whereClauses.push(`s.grade = ?`);
      queryArgs.push(gNum);
    } else {
      whereClauses.push(`s.grade_raw = ?`);
      queryArgs.push(String(params.grade));
    }
  }

  // 3. 分校（D3 Task 5: 換行複值集合語義——整值相等或換行邊界精確匹配）
  if (params.branch) {
    const b = String(params.branch);
    whereClauses.push(`(
      s.branch = ?
      OR s.branch LIKE ? ESCAPE '\\'
      OR s.branch LIKE ? ESCAPE '\\'
      OR s.branch LIKE ? ESCAPE '\\'
    )`);
    const esc = b.replace(/[\\%_]/g, (c) => '\\' + c);
    queryArgs.push(b, `${esc}\n%`, `%\n${esc}`, `%\n${esc}\n%`);
  }

  // 4. 有無班級 (hasClass)
  if (params.hasClass !== undefined && params.hasClass !== '') {
    const hasClassBool = params.hasClass === true || params.hasClass === 'true';
    if (hasClassBool) {
      whereClauses.push(
        `EXISTS (SELECT 1 FROM student_enrollments e WHERE e.import_id = s.import_id AND e.person_code = s.person_code)`
      );
    } else {
      whereClauses.push(
        `NOT EXISTS (SELECT 1 FROM student_enrollments e WHERE e.import_id = s.import_id AND e.person_code = s.person_code)`
      );
    }
  }

  // 5. 搜尋關鍵字 (姓名或代碼)
  if (params.q && params.q.trim()) {
    const term = `%${params.q.trim()}%`;
    whereClauses.push(`(s.name LIKE ? OR s.person_code LIKE ?)`);
    queryArgs.push(term, term);
  }

  // 6. erpBillingTier
  if (params.erpBillingTier !== undefined && params.erpBillingTier !== '') {
    const tierNum = parseFloat(String(params.erpBillingTier));
    whereClauses.push(
      `EXISTS (SELECT 1 FROM student_enrollments e WHERE e.import_id = s.import_id AND e.person_code = s.person_code AND e.erp_billing_tier = ?)`
    );
    queryArgs.push(tierNum);
  }

  // 計算符合條件的總人數與去重統計
  const baseWhereSql = whereClauses.join(' AND ');
  const totalCountRow = db
    .prepare(`SELECT COUNT(DISTINCT s.person_code) as total FROM imported_students s WHERE ${baseWhereSql}`)
    .get(...queryArgs) as { total: number };
  const totalStudents = totalCountRow ? totalCountRow.total : 0;

  // 統計有班與無班人數
  const withClassCountRow = db
    .prepare(`
      SELECT COUNT(DISTINCT s.person_code) as total
      FROM imported_students s
      WHERE ${baseWhereSql}
        AND EXISTS (SELECT 1 FROM student_enrollments e WHERE e.import_id = s.import_id AND e.person_code = s.person_code)
    `)
    .get(...queryArgs) as { total: number };

  const withoutClassCountRow = db
    .prepare(`
      SELECT COUNT(DISTINCT s.person_code) as total
      FROM imported_students s
      WHERE ${baseWhereSql}
        AND NOT EXISTS (SELECT 1 FROM student_enrollments e WHERE e.import_id = s.import_id AND e.person_code = s.person_code)
    `)
    .get(...queryArgs) as { total: number };

  // 分頁過濾 (cursor)
  const pagedWhereClauses = [...whereClauses];
  const pagedArgs = [...queryArgs];

  if (lastPersonCode) {
    pagedWhereClauses.push(`s.person_code > ?`);
    pagedArgs.push(lastPersonCode);
  }

  pagedArgs.push(limit + 1); // 多取一筆判斷是否有下一頁

  const pagedSql = `
    SELECT s.*
    FROM imported_students s
    WHERE ${pagedWhereClauses.join(' AND ')}
    ORDER BY s.person_code ASC
    LIMIT ?
  `;

  const studentRows = db.prepare(pagedSql).all(...pagedArgs) as any[];

  const hasNextPage = studentRows.length > limit;
  const itemsRows = hasNextPage ? studentRows.slice(0, limit) : studentRows;

  let nextCursor: string | null = null;
  if (hasNextPage && itemsRows.length > 0) {
    const lastItem = itemsRows[itemsRows.length - 1];
    nextCursor = Buffer.from(lastItem.person_code).toString('base64');
  }

  // 取得學生對應的 enrollments
  const personCodes = itemsRows.map((r) => r.person_code);
  const enrollmentsMap: Record<string, ParsedToken[]> = {};

  if (personCodes.length > 0) {
    const placeholders = personCodes.map(() => '?').join(',');
    const enrRows = db
      .prepare(`
        SELECT * FROM student_enrollments
        WHERE import_id = ? AND person_code IN (${placeholders})
        ORDER BY token_index ASC
      `)
      .all(importId, ...personCodes) as any[];

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

  const items: StudentSnapshot[] = itemsRows.map((r) => ({
    personCode: r.person_code,
    name: r.name,
    branch: r.branch,
    gradeRaw: r.grade_raw,
    grade: r.grade,
    gradeStatus: r.grade_status,
    contact: r.contact,
    schoolInfo: r.school_info,
    tagsRaw: r.tags_raw,
    tags: r.tags_raw
      ? r.tags_raw.split(/[,;\s]+/).map((t: string) => t.trim()).filter((t: string) => t.length > 0)
      : [],
    notesRaw: r.notes_raw,
    enrollments: enrollmentsMap[r.person_code] || [],
    sourceRow: r.source_row,
  }));

  return {
    items,
    totalStudents,
    nextCursor,
    stats: {
      totalStudents,
      studentsWithClass: withClassCountRow ? withClassCountRow.total : 0,
      studentsWithoutClass: withoutClassCountRow ? withoutClassCountRow.total : 0,
    },
  };
}
