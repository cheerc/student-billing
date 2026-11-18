import Database from 'better-sqlite3';
import { StudentCalculationRecord, getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { ParsedToken } from '@/domain/students';
import { createStudentPredicateBuilder } from './student-query-predicates';
import { normalizeStudentQuery, StudentQueryInputError, queryIdentity, decodeStudentCursor, encodeStudentCursor, decodeColumnCursor, encodeColumnCursor, type NormalizedStudentQuery } from '@/contracts/student-query';
import { resolveSingleClassName, type ColumnFilterKeys, type ColumnSelection } from '@/contracts/column-filter';
import { matchesColumnSelection, type Cell } from '@/lib/table-columns/cell';
import { compareCells } from '@/lib/table-columns/compare';
import { STUDENT_COLUMN_SPECS, enrollmentCellsOf, studentColumnSpec, type StudentColumnCtx } from '@/lib/table-columns/student-columns';
import { noCoursePredicate } from './student-query-sql';
import { RUN_SORT_COLUMNS, RUN_SORT_COLUMN_KEYS } from '@/contracts/student-sort-fields';

export { RUN_SORT_COLUMNS };
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

/** `/runs/{id}/students` 接受的 `col.<columnKey>`（03 §5.1 R6）：已知＝13 欄，可篩選＝其中 filterable 者。 */
export const RUN_COLUMN_FILTER_KEYS: ColumnFilterKeys = {
  known: new Set(STUDENT_COLUMN_SPECS.map((c) => c.key)),
  filterable: new Set(STUDENT_COLUMN_SPECS.filter((c) => c.filterable).map((c) => c.key)),
};

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

/** 畫面與 API 的問題欄位：有任何問題，或任一級距比對需人工確認（needsReview）即為有問題。 */
function issueView<T extends { code: string }>(
  issues: readonly T[],
  tierComparisons: ReadonlyArray<{ needsReview?: boolean | null }>
): { actionableIssues: T[]; actionableHasIssues: boolean } {
  return {
    actionableIssues: [...issues],
    actionableHasIssues: issues.length > 0 || tierComparisons.some((c) => c.needsReview === true),
  };
}

function parseRunQuery(params: RunStudentQueryParams): NormalizedStudentQuery {
  try {
    return normalizeStudentQuery(params, ALLOWED_RUN_QUERY_PARAMS, new Set(Object.keys(RUN_SORT_COLUMNS)), RUN_COLUMN_FILTER_KEYS);
  } catch (error) {
    if (error instanceof StudentQueryInputError) throw new QueryStudentError(400, error.message);
    throw error;
  }
}

export function validateRunQueryParams(params: Record<string, any>): void {
  parseRunQuery(params);
}

/** student_enrollments 列 → ParsedToken（列表與明細共用）。 */
function toParsedToken(er: any): ParsedToken {
  return {
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
}

/**
 * student_calculations 列（含 `source_row`）＋報名 → StudentCalculationItem。列表、`col.*` 篩選、選項與明細共用同一映射
 * （D66 P-5；儲存格的 `cells()` 與列表回應讀到的是同一個 item）。
 * `trace`：`list` 將備註全文脫敏為 `hasNotes`（D3 Task 5）；`full` 保留原文（明細端點）。
 */
export function toStudentItem(r: any, enrollments: ParsedToken[], trace: 'list' | 'full'): StudentCalculationItem {
  const tierComparisons = JSON.parse(r.tier_comparisons);
  const issues = JSON.parse(r.issues);
  const actionable = issueView(issues, tierComparisons);
  const parsedTrace = JSON.parse(r.trace);
  return {
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
    tierComparisons,
    issues,
    hasIssues: Boolean(r.has_issues),
    ...actionable,
    trace: trace === 'full' ? parsedTrace : (() => {
      // D3 Task 5: 列表脫敏——備註全文不進列表，僅保留 hasNotes 布林；完整原文由明細端點按需查閱
      const rawNotes = parsedTrace?.rawNotes ?? null;
      const { rawNotes: _dropped, ...rest } = parsedTrace ?? {};
      return { ...rest, hasNotes: rawNotes !== null && String(rawNotes).trim() !== '' };
    })(),
    createdAt: r.created_at,
    enrollments,
    // D3 Task 4: 班級全文由 enrollments rawToken 依 token_index 升冪以換行拼回（正規化去除 \r）
    classText: enrollments.length > 0 ? enrollments.map((e) => e.rawToken.trim().replace(/\r\n/g, '').replace(/\r/g, '')).join('\n') : null,
    sourceRow: r.source_row ?? 0,
  };
}

const ITEM_ROW_SQL = `SELECT sc.*, s.source_row FROM student_calculations sc LEFT JOIN imported_students s ON s.import_id = ? AND s.person_code = sc.person_code`;

/** 該 import 全部報名列（token_index 升冪），依 personCode 分組；轉 ParsedToken 延後到取用時。 */
function loadEnrollmentRows(db: Database.Database, importId: string): Map<string, any[]> {
  const grouped = new Map<string, any[]>();
  const rows = db.prepare('SELECT * FROM student_enrollments WHERE import_id = ? ORDER BY token_index ASC').all(importId) as any[];
  for (const er of rows) {
    const list = grouped.get(er.person_code);
    if (list) list.push(er); else grouped.set(er.person_code, [er]);
  }
  return grouped;
}
const tokensOf = (grouped: Map<string, any[]>, personCode: string): ParsedToken[] => (grouped.get(personCode) ?? []).map(toParsedToken);

/** 該 run 全部學生的 item（選項值宇宙與 `col.*` 範圍用）。 */
export function loadRunStudentItems(db: Database.Database, runId: string, importId: string): StudentCalculationItem[] {
  const grouped = loadEnrollmentRows(db, importId);
  const rows = db.prepare(`${ITEM_ROW_SQL} WHERE sc.run_id = ? ORDER BY sc.person_code ASC`).all(importId, runId) as any[];
  return rows.map((r) => toStudentItem(r, tokensOf(grouped, r.person_code), 'list'));
}

/** `col.*` 評估情境：恰選一班（R7）與該 run 的班級類別快照。 */
export function buildStudentColumnCtx(query: NormalizedStudentQuery, snapshots: StudentColumnCtx['snapshots']): StudentColumnCtx {
  return { singleClass: resolveSingleClassName(query.selections.enrollmentKey, query.columns.enrollment), snapshots };
}

/** 通過全部（排除 `exceptKey` 那一欄）`col.*` 條件：跨欄 AND，同欄依顯示文字 OR（matchesColumnSelection）。 */
export function studentPassesColumns(item: StudentCalculationItem, columns: Record<string, ColumnSelection>, ctx: StudentColumnCtx, exceptKey?: string): boolean {
  for (const [key, selection] of Object.entries(columns)) {
    if (key === exceptKey) continue;
    const spec = studentColumnSpec(key);
    if (!spec || !matchesColumnSelection(spec.cells(item, ctx), selection)) return false;
  }
  return true;
}

const inCodes = (codes: readonly string[]) => ({ sql: 'sc.person_code IN (SELECT value FROM json_each(?))', args: [JSON.stringify(codes)] });
const utf8 = (code: string) => Buffer.from(code, 'utf8');

export function queryRunStudents(db: Database.Database, runId: string, params: RunStudentQueryParams): RunStudentsQueryResult {
  const query = parseRunQuery(params);
  const run = getCalculationRun(db, runId);
  if (!run) throw new QueryStudentError(404, `找不到計算 run: ${runId}`);
  if (query.runId && query.runId !== runId) throw new QueryStudentError(400, 'runId 與路徑不符');
  const limit = query.limit;
  // D66 R8：帶 sort 的請求走 application 層 compareCells＋cursor v3（identity 納入 cursorVersion 3，舊版／錯版 cursor 一律 400 指名 cursor）；
  // 未帶 sort 維持 personCode UTF-8 位元組序與 v2 無排序 cursor（UX128／UX131 (e) 不變）。
  const sort = query.sort;
  const identity = queryIdentity(`run:${runId}:import:${run.importId}`, query, sort ? 3 : undefined);
  let after: ReturnType<typeof decodeStudentCursor> = null;
  let afterSorted: ReturnType<typeof decodeColumnCursor> = null;
  try {
    if (sort) afterSorted = decodeColumnCursor(query.cursor, identity, true);
    else after = decodeStudentCursor(query.cursor, identity);
  } catch (error) { throw new QueryStudentError(400, (error as Error).message); }
  const selected = query.selections;

  // 第一段：SQL 前篩（語意參數＋q／subject）。
  const { where, classes, mismatch, issues } = createStudentPredicateBuilder(db, runId, run.importId)(query);
  const grouped = loadEnrollmentRows(db, run.importId);
  const columnEntries = Object.entries(query.columns);
  const columnCtx = buildStudentColumnCtx(query, run.classCategories);

  // 第二段：application 層 `col.*`（與儲存格同一份 cells()）與排序；沒有 col.* 時最終集合＝前篩集合（finalCodes 為 null）。
  // 帶 col.* 或 sort 才需要完整 item；`candidates` 即最終集合的 item（已含 col.* 篩選），排序與 keyset 直接用它。
  let finalCodes: string[] | null = null;
  let candidates: StudentCalculationItem[] = [];
  if (columnEntries.length || sort) {
    const prefiltered = db.prepare(`${ITEM_ROW_SQL} WHERE ${where.sql}`).all(run.importId, ...where.args) as any[];
    for (const r of prefiltered) {
      const item = toStudentItem(r, tokensOf(grouped, r.person_code), 'list');
      if (!columnEntries.length || studentPassesColumns(item, query.columns, columnCtx)) candidates.push(item);
    }
    if (columnEntries.length) finalCodes = candidates.map((item) => item.personCode);
  }
  const final = finalCodes ? inCodes(finalCodes) : { sql: '1', args: [] as string[] };
  const scopeSql = `${where.sql} AND ${final.sql}`;
  const scopeArgs = [...where.args, ...final.args];

  // stats 一律以最終集合計算（D66 P-6）。
  const noCourse = noCoursePredicate(run.importId, 'sc');
  const count = (extraSql: string, extraArgs: Array<string | number> = []) =>
    (db.prepare(`SELECT COUNT(*) AS total FROM student_calculations sc WHERE ${scopeSql}${extraSql}`).get(...scopeArgs, ...extraArgs) as { total: number }).total;
  const totalStudents = finalCodes ? finalCodes.length : count('');
  const mismatchCount = count(` AND ${mismatch.sql}`, mismatch.args);
  const issuesCount = count(` AND ${issues.sql}`, issues.args);
  const noCourseTotal = (db.prepare(`SELECT COUNT(*) AS total FROM student_calculations sc WHERE sc.run_id = ? AND ${noCourse.sql}`).get(runId, ...noCourse.args) as { total: number }).total;
  const filteredNoCourseCount = count(` AND ${noCourse.sql}`, noCourse.args);
  const emptySelection = Object.values(selected).some((s) => s.none) || columnEntries.some(([, c]) => c.none);
  let classScopeTotal: number;
  if (emptySelection) classScopeTotal = 0;
  else if (query.columns.enrollment) {
    // 只套班級條件（語意 enrollmentKey 與 col.enrollment 兩來源皆算），不含其他條件。
    const classScoped = db.prepare(`SELECT sc.person_code FROM student_calculations sc WHERE sc.run_id = ? AND ${classes.sql}`).all(runId, ...classes.args) as Array<{ person_code: string }>;
    classScopeTotal = classScoped.filter((r) => matchesColumnSelection(enrollmentCellsOf(tokensOf(grouped, r.person_code)), query.columns.enrollment)).length;
  } else {
    classScopeTotal = (db.prepare(`SELECT COUNT(*) AS total FROM student_calculations sc WHERE sc.run_id = ? AND ${classes.sql}`).get(runId, ...classes.args) as { total: number }).total;
  }

  // 分頁：
  // - 未帶 sort：JS 依 personCode 的 UTF-8 位元組序（Buffer.compare；＝SQLite BINARY `person_code ASC`）排序並以 v2 無排序 cursor 分頁。
  // - 帶 sort（D66 R3／R8）：對最終集合的每列取排序欄的 Cell `{ value, text }`（與儲存格同一份 cells()），
  //   依完整比較鍵 `(value, text, personCode)` 排序與 keyset：降冪反轉 value 與 text、空白恆最後、personCode 恆升冪（UTF-8 位元組序）。
  let items: StudentCalculationItem[];
  let nextCursor: string | null = null;
  if (!sort) {
    const codes = finalCodes ?? (db.prepare(`SELECT sc.person_code FROM student_calculations sc WHERE ${scopeSql}`).all(...scopeArgs) as Array<{ person_code: string }>).map((r) => r.person_code);
    const keyed = codes.map((code) => ({ code, bytes: utf8(code) })).sort((a, b) => Buffer.compare(a.bytes, b.bytes));
    const afterBytes = after ? utf8(after.personCode) : null;
    const rest = afterBytes ? keyed.filter((k) => Buffer.compare(k.bytes, afterBytes) > 0) : keyed;
    const page = rest.slice(0, limit + 1).map((k) => k.code);
    const byCode = new Map((db.prepare(`${ITEM_ROW_SQL} WHERE sc.run_id = ? AND ${inCodes(page).sql}`).all(run.importId, runId, ...inCodes(page).args) as any[]).map((r) => [r.person_code as string, r]));
    const rows = page.map((code) => byCode.get(code)!);
    const hasNext = rows.length > limit;
    const itemRows = hasNext ? rows.slice(0, limit) : rows;
    nextCursor = hasNext && itemRows.length ? encodeStudentCursor(identity, { personCode: itemRows[itemRows.length - 1].person_code, sortValue: undefined }) : null;
    items = itemRows.map((r) => toStudentItem(r, tokensOf(grouped, r.person_code), 'list'));
  } else {
    const spec = studentColumnSpec(RUN_SORT_COLUMN_KEYS[sort.field])!;
    const keyed = candidates.map((item) => ({ item, cell: (spec.cells(item, columnCtx).find((c) => c !== null) ?? null) as Cell, bytes: utf8(item.personCode) }));
    const order = (a: { cell: Cell; bytes: Buffer }, b: { cell: Cell; bytes: Buffer }) => compareCells(a.cell, b.cell, sort.dir) || Buffer.compare(a.bytes, b.bytes);
    keyed.sort(order);
    const anchor = afterSorted ? { cell: afterSorted.cell ?? null, bytes: utf8(afterSorted.personCode) } : null;
    const rest = anchor ? keyed.filter((k) => order(k, anchor) > 0) : keyed;
    const page = rest.slice(0, limit + 1);
    const hasNext = page.length > limit;
    const shown = hasNext ? page.slice(0, limit) : page;
    items = shown.map((k) => k.item);
    const last = shown[shown.length - 1];
    nextCursor = hasNext && last ? encodeColumnCursor(identity, { personCode: last.item.personCode, cell: last.cell }) : null;
  }

  return {
    runId,
    items,
    totalStudents,
    nextCursor,
    noCourseTotal,
    stats: { totalStudents, mismatchCount, issuesCount, classScopeTotal, filteredNoCourseCount },
  };
}

export function getStudentCalculationDetail(
  db: Database.Database,
  runId: string,
  personCode: string
): StudentCalculationItem | null {
  const run = getCalculationRun(db, runId);
  if (!run) return null;

  const row = db.prepare(`${ITEM_ROW_SQL} WHERE sc.run_id = ? AND sc.person_code = ?`).get(run.importId, runId, personCode) as any;
  if (!row) return null;

  const enrRows = db
    .prepare(`
      SELECT * FROM student_enrollments
      WHERE import_id = ? AND person_code = ?
      ORDER BY token_index ASC
    `)
    .all(run.importId, personCode) as any[];

  return toStudentItem(row, enrRows.map(toParsedToken), 'full');
}
