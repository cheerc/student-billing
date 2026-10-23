import Database from 'better-sqlite3';
import { StudentSnapshot, ParsedToken } from '@/domain/students';
import { normalizeStudentQuery, StudentQueryInputError, queryIdentity, decodeStudentCursor, encodeStudentCursor } from '@/contracts/student-query';
import { classPredicate, selectionPredicate, branchPredicate, escapeLike, type QueryPredicate } from './student-query-sql';
import { getLatestSettingsVersion, readStoredDraft, buildSeedDraft, draftToAliasMap } from '@/adapters/sqlite/settings-repository';
import { buildClassSettingMap } from './calculate-run';
import { resolveClassEnrollment } from '@/domain/classification/class-category';
import { projectTierForApplicability } from '@/domain/students/token-parser';

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
  'previewErpBillingTier',
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
  'anqinDays',
  'tutoringDays',
  'options',
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
  noCourseTotal: number;
  nextCursor: string | null;
  tierPreviewSource: 'latest_settings' | 'seed';
  stats: {
    totalStudents: number;
    studentsWithClass: number;
    studentsWithoutClass: number;
    filteredNoCourseCount: number;
  };
}

export function validateImportQueryParams(params: Record<string, any>): void {
  parseImportQuery(params);
}

function parseImportQuery(params: RosterQueryParams) {
  for (const key of Object.keys(params)) {
    if (FORBIDDEN_CALCULATION_PARAMS.has(key)) throw new RosterQueryError(400, `參數「${key}」為正式計算 run 專屬參數，預覽名單查詢不支援此參數。`);
  }
  try { return normalizeStudentQuery(params, ALLOWED_IMPORT_QUERY_PARAMS); }
  catch (error) {
    if (error instanceof StudentQueryInputError) throw new RosterQueryError(400, error.message);
    throw error;
  }
}

export function queryImportStudents(db: Database.Database, importId: string, params: RosterQueryParams): RosterQueryResult {
  const query = parseImportQuery(params);
  const limit = query.limit;
  const identity = queryIdentity(`import:${importId}`, query);
  let lastPersonCode: string | null;
  try { lastPersonCode = decodeStudentCursor(query.cursor, identity); }
  catch (error) { throw new RosterQueryError(400, (error as Error).message); }
  const whereClauses = ['s.import_id = ?'];
  const queryArgs: Array<string | number> = [importId];
  const add = (p: QueryPredicate) => { whereClauses.push(p.sql); queryArgs.push(...p.args); };
  const selected = query.selections;
  const savedSettings = getLatestSettingsVersion(db);
  const settingsDraft = savedSettings ? readStoredDraft(savedSettings.contentJson) : buildSeedDraft();
  const aliasMap = draftToAliasMap(settingsDraft);
  const classSettings = buildClassSettingMap(settingsDraft);
  const projectEnrollmentTier = (row: any) => {
    const token: ParsedToken = {
      rawToken: row.raw_token,
      yearPrefix: row.year_prefix,
      baseName: row.base_name,
      groupFlag: row.group_flag,
      modifiers: row.modifiers ? JSON.parse(row.modifiers) : [],
      withdrawalDate: row.withdrawal_date,
      erpBillingTierRaw: row.erp_billing_tier_raw,
      erpBillingTier: row.erp_billing_tier,
      tierParseStatus: row.tier_parse_status,
      parseStatus: row.parse_status,
    };
    const resolved = resolveClassEnrollment(token, aliasMap, classSettings);
    return projectTierForApplicability(token, resolved.erpTierApplicability);
  };
  add(classPredicate(importId, 's', selected.enrollmentKey));
  add(selectionPredicate(selected.grade, 's.grade'));
  add(branchPredicate('s.branch', selected.branch));
  const hasClass = 'EXISTS (SELECT 1 FROM student_enrollments e WHERE e.import_id = s.import_id AND e.person_code = s.person_code)';
  add(selectionPredicate(selected.hasClass, hasClass, '0'));
  const previewTierSelection = selected.previewErpBillingTier;
  if (previewTierSelection) {
    if (previewTierSelection.none) {
      whereClauses.push('0');
    } else {
      const matchingCodes = new Set<string>();
      const rows = db.prepare('SELECT * FROM student_enrollments WHERE import_id = ?').all(importId) as any[];
      for (const row of rows) {
        const projected = projectEnrollmentTier(row);
        if (previewTierSelection.values.includes(projected.erpBillingTier)) matchingCodes.add(row.person_code);
      }
      if (matchingCodes.size === 0) {
        whereClauses.push('0');
      } else {
        const codes = [...matchingCodes];
        whereClauses.push(`s.person_code IN (${codes.map(() => '?').join(',')})`);
        queryArgs.push(...codes);
      }
    }
  }
  if (query.q) {
    whereClauses.push("(s.name LIKE ? ESCAPE '\\' OR s.person_code LIKE ? ESCAPE '\\')");
    queryArgs.push(`%${escapeLike(query.q)}%`, `%${escapeLike(query.q)}%`);
  }
  if (query.subject) {
    whereClauses.push("EXISTS (SELECT 1 FROM student_enrollments e WHERE e.import_id = s.import_id AND e.person_code = s.person_code AND (e.base_name LIKE ? ESCAPE '\\' OR e.raw_token LIKE ? ESCAPE '\\'))");
    queryArgs.push(`%${escapeLike(query.subject)}%`, `%${escapeLike(query.subject)}%`);
  }
  const tiers = selected.erpBillingTier;
  if (tiers) {
    if (tiers.none) add({ sql: '0', args: [] });
    else {
      const p = selectionPredicate(tiers, 'e.erp_billing_tier');
      add({ sql: `EXISTS (SELECT 1 FROM student_enrollments e WHERE e.import_id = s.import_id AND e.person_code = s.person_code AND ${p.sql})`, args: p.args });
    }
  }
  const baseWhereSql = whereClauses.join(' AND ');
  const totalCountRow = db.prepare(`SELECT COUNT(DISTINCT s.person_code) AS total FROM imported_students s WHERE ${baseWhereSql}`).get(...queryArgs) as { total: number };
  const totalStudents = totalCountRow.total;
  const withClassCountRow = db.prepare(`SELECT COUNT(DISTINCT s.person_code) AS total FROM imported_students s WHERE ${baseWhereSql} AND ${hasClass}`).get(...queryArgs) as { total: number };
  const withoutClassCountRow = db.prepare(`SELECT COUNT(DISTINCT s.person_code) AS total FROM imported_students s WHERE ${baseWhereSql} AND NOT (${hasClass})`).get(...queryArgs) as { total: number };
  const noCourseTotal = (db.prepare(`SELECT COUNT(DISTINCT s.person_code) AS total FROM imported_students s WHERE s.import_id = ? AND NOT (${hasClass})`).get(importId) as { total: number }).total;
  const pagedWhereClauses = [...whereClauses];
  const pagedArgs = [...queryArgs];
  if (lastPersonCode) { pagedWhereClauses.push('s.person_code > ?'); pagedArgs.push(lastPersonCode); }
  pagedArgs.push(limit + 1);
  const studentRows = db.prepare(`SELECT s.* FROM imported_students s WHERE ${pagedWhereClauses.join(' AND ')} ORDER BY s.person_code ASC LIMIT ?`).all(...pagedArgs) as any[];
  const hasNextPage = studentRows.length > limit;
  const itemsRows = hasNextPage ? studentRows.slice(0, limit) : studentRows;
  const nextCursor = hasNextPage && itemsRows.length ? encodeStudentCursor(identity, itemsRows[itemsRows.length - 1].person_code) : null;

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
      const enrollment: ParsedToken = {
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
      };
      const preview = projectEnrollmentTier(er);
      enrollmentsMap[er.person_code].push({
        ...enrollment,
        previewErpBillingTier: preview.erpBillingTier,
        previewErpBillingTierRaw: preview.erpBillingTierRaw,
        previewTierParseStatus: preview.tierParseStatus,
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
    tierPreviewSource: savedSettings ? 'latest_settings' : 'seed',
    nextCursor,
    noCourseTotal,
    stats: {
      totalStudents,
      studentsWithClass: withClassCountRow ? withClassCountRow.total : 0,
      studentsWithoutClass: withoutClassCountRow ? withoutClassCountRow.total : 0,
      filteredNoCourseCount: withoutClassCountRow ? withoutClassCountRow.total : 0,
    },
  };
}
