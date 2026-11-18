import { createHash } from 'crypto';
import { TEXT_SORT_FIELDS } from './student-sort-fields';
import { isColumnParam, parseColumnFilters, resolveSingleClassName, type ColumnFilterKeys, type ColumnSelection } from './column-filter';

export type QueryValue = string | number | boolean | null;
export type StudentQueryInput = Record<string, any>;
export interface QuerySelection { values: QueryValue[]; none: boolean }
export interface NormalizedStudentQuery {
  selections: Record<string, QuerySelection>;
  /** D66 `col.<columnKey>` 表頭欄位篩選（顯示文字）；與 selections 為 AND。 */
  columns: Record<string, ColumnSelection>;
  q?: string;
  subject?: string;
  careType?: 'anqin' | 'tutoring';
  runId?: string;
  cursor?: string;
  sort?: SortSpec;
  limit: number;
  options: boolean;
}

/** D65：`sort=<field>`／`sort=-<field>`（降冪）。欄位白名單由各查詢入口提供。 */
export interface SortSpec { field: string; dir: 'asc' | 'desc' }
/** keyset 游標位置；`sortValue` 為 undefined＝未排序（預設 person_code 序），null＝該列排序欄為空值。 */
export interface CursorPosition { personCode: string; sortValue?: string | number | null }

export class StudentQueryInputError extends Error {
  statusCode = 400;
}

export const KNOWN_ISSUE_CODES = new Set([
  'DUPLICATE_SUBJECT_ENROLLMENT', 'STAFF_FAMILY_NO_DISCOUNT', 'CONFLICTING_NOTE_SOURCE',
  'CLASS_NOT_MAPPED', 'SCHEDULE_NOT_FOUND', 'SCHEDULE_EMPTY', 'SCHEDULE_INCOMPLETE', 'UNKNOWN_WEEKDAY',
]);
export const VALID_TIER_COMPARISONS = new Set(['match', 'mismatch', 'not_applicable', 'unavailable']);

const BOOLEAN_KEYS = new Set(['hasClass', 'sibling', 'specialDiscount', 'internalStudent', 'hasExtraDeduction', 'hasIssues', 'tierMismatch']);
const INTEGER_KEYS = new Set(['grade', 'baseDiscountBps', 'applicableDiscountBps']);
const NUMBER_KEYS = new Set(['anqinDays', 'tutoringDays', 'billingTier', 'erpBillingTier', 'previewErpBillingTier']);
const SINGLE_KEYS = new Set(['q', 'subject', 'careType', 'runId', 'cursor', 'limit', 'options', 'billingTier', 'sort']);

/** URL 與 application 呼叫共用：不壓掉同一參數的重複值。 */
export function readStudentQuery(searchParams: URLSearchParams): StudentQueryInput {
  const result: StudentQueryInput = {};
  for (const key of new Set(searchParams.keys())) result[key] = searchParams.getAll(key);
  return result;
}

function invalid(key: string, reason: string): never {
  throw new StudentQueryInputError(`查詢參數「${key}」${reason}`);
}

function selection(key: string, raw: string[]): QuerySelection | undefined {
  if (raw.includes('~none')) {
    if (raw.length !== 1) invalid(key, '的 ~none 只能單獨出現');
    return { values: [], none: true };
  }
  if (raw.includes('~empty') && raw.includes('~blank')) invalid(key, '的 ~empty 與 ~blank 不得混用');
  const values: QueryValue[] = [];
  for (const wire of raw) {
    if (wire === '') continue; // 既有空字串相容；UI 的空白使用 ~blank。
    if (wire === '~blank') { values.push(null); continue; }
    if (wire === '~empty') {
      if (key !== 'enrollmentKey' && key !== 'classId') invalid(key, '不支援空班名保留值 ~empty');
      values.push('');
      continue;
    }
    if (wire.startsWith('~') && !wire.startsWith('~~')) invalid(key, '有未知保留值');
    const value = wire.startsWith('~~') ? wire.slice(1) : wire;
    if (BOOLEAN_KEYS.has(key)) {
      if (value !== 'true' && value !== 'false') invalid(key, '只接受 true／false');
      values.push(value === 'true');
    } else if (INTEGER_KEYS.has(key) || NUMBER_KEYS.has(key)) {
      const pattern = INTEGER_KEYS.has(key) ? /^-?\d+$/ : /^-?\d+(?:\.\d+)?$/;
      if (!pattern.test(value) || !Number.isFinite(Number(value))) invalid(key, '必須是有效數值');
      if (INTEGER_KEYS.has(key) && !Number.isSafeInteger(Number(value))) invalid(key, '必須是安全整數');
      values.push(Number(value));
    } else {
      if (key === 'issueCode' && !KNOWN_ISSUE_CODES.has(value)) invalid(key, '有未知問題碼');
      if (key === 'tierComparison' && !VALID_TIER_COMPARISONS.has(value)) invalid(key, '有無效比較狀態');
      values.push(value);
    }
  }
  const unique = [...new Map(values.map((v) => [JSON.stringify(v), v])).values()];
  unique.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return unique.length ? { values: unique, none: false } : undefined;
}

/**
 * `columnKeys`：該端點接受的 `col.*` 欄位（03 §5.1 R6）；未提供者（如匯入預覽 `parseImportQuery`）遇 `col.*` 一律 400。
 */
export function normalizeStudentQuery(input: StudentQueryInput, allowed: ReadonlySet<string>, sortFields: ReadonlySet<string> = new Set(), columnKeys?: ColumnFilterKeys): NormalizedStudentQuery {
  const result: NormalizedStudentQuery = { selections: {}, columns: {}, limit: 50, options: false };
  for (const key of Object.keys(input)) {
    if (isColumnParam(key)) {
      if (!columnKeys) invalid(key, '未知或不支援');
      continue; // 由 parseColumnFilters 統一解析
    }
    if (!allowed.has(key)) invalid(key, '未知或不支援');
    if (['scheduleStatus', 'mappingStatus'].includes(key)) invalid(key, '尚未實作，請勿指定');
    const source = input[key];
    if (source === undefined || source === null) continue;
    const raw = (Array.isArray(source) ? source : [source]).map(String);
    if (SINGLE_KEYS.has(key) && raw.length > 1) invalid(key, '只能指定一次');
    if (key === 'sort') {
      if (raw[0] === '') continue;
      const desc = raw[0].startsWith('-');
      const field = desc ? raw[0].slice(1) : raw[0];
      if (!sortFields.has(field)) invalid('sort', `只接受：${[...sortFields].join('、') || '（此端點不支援排序）'}（降冪加前綴 -）`);
      result.sort = { field, dir: desc ? 'desc' : 'asc' };
    } else if (key === 'limit') {
      if (raw[0] === '') continue;
      if (!/^\d+$/.test(raw[0]) || !Number.isSafeInteger(Number(raw[0])) || Number(raw[0]) <= 0) invalid(key, '必須為正整數');
      result.limit = Math.min(200, Number(raw[0]));
    } else if (key === 'options') {
      if (!['true', 'false'].includes(raw[0])) invalid(key, '只接受 true／false');
      result.options = raw[0] === 'true';
    } else if (['q', 'subject', 'cursor', 'runId'].includes(key)) {
      if (raw[0]) (result as any)[key] = ['q', 'subject'].includes(key) ? raw[0].trim() : raw[0];
    } else if (key === 'careType') {
      if (!raw[0]) continue;
      if (raw[0] !== 'anqin' && raw[0] !== 'tutoring') invalid(key, '只接受 anqin／tutoring');
      result.careType = raw[0];
    } else {
      const selected = selection(key, raw);
      if (selected) result.selections[key] = selected;
    }
  }
  // 同義班級參數：enrollmentKey 優先；canonical identity 不保留被忽略的別名。
  if (result.selections.enrollmentKey) delete result.selections.classId;
  else if (result.selections.classId) {
    result.selections.enrollmentKey = result.selections.classId;
    delete result.selections.classId;
  }
  if (columnKeys) {
    result.columns = parseColumnFilters(input, columnKeys);
    if (result.columns.applicableDiscount && resolveSingleClassName(result.selections.enrollmentKey, result.columns.enrollment) === null) {
      throw new StudentQueryInputError('查詢參數「col.applicableDiscount」須恰選一個班級（col.enrollment 與／或 enrollmentKey 各恰選一個非空白班名；兩者並存須為同一班）');
    }
  }
  if (result.selections.billingTier && !result.careType) invalid('billingTier', '必須同時帶 careType');
  const issue = result.selections.issueCode;
  const hasIssues = result.selections.hasIssues?.values;
  if (issue && hasIssues?.length === 1 && hasIssues[0] === false) invalid('hasIssues', 'false 與 issueCode 衝突');
  const mismatch = result.selections.tierMismatch?.values;
  const comparisons = result.selections.tierComparison?.values;
  if (mismatch?.length === 1 && comparisons?.includes(mismatch[0] === true ? 'match' : 'mismatch')) invalid('tierMismatch', '與 tierComparison 衝突');
  if (result.selections.applicableDiscountBps) {
    const classes = result.selections.enrollmentKey;
    if (!classes || classes.none || classes.values.length !== 1 || classes.values[0] === null) invalid('applicableDiscountBps', '須恰選一個班級');
  }
  return result;
}

/**
 * `cursorVersion`：只有 D66 cursor v3 的端點（學生總表、帶 `sort`）傳入；納入 identity 使舊版 cursor 因 identity 不符回 400。
 * 未傳（匯入預覽 `roster-query`、未排序請求）時 identity 與先前逐位元相同。
 */
export function queryIdentity(scope: string, query: NormalizedStudentQuery, cursorVersion?: number): string {
  const filters = Object.fromEntries(Object.entries(query.selections).sort(([a], [b]) => a.localeCompare(b)));
  // col.* 只在有條件時才進 identity：未帶 col.* 的請求 identity 與 D66 之前逐位元相同。
  const columns = Object.entries(query.columns ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, c]) => [key, { texts: [...c.texts].sort(), blank: c.blank, none: c.none }]);
  const extra = { ...(columns.length ? { columns } : {}), ...(cursorVersion ? { cursorVersion } : {}) };
  return createHash('sha256').update(JSON.stringify({ scope, filters, ...extra, q: query.q || '', subject: query.subject || '', careType: query.careType || '', sort: query.sort ? `${query.sort.dir}:${query.sort.field}` : '' })).digest('hex');
}

/** v2 keyset：`n`＝排序值為 null（與任何實值，含空字串、0，皆可區分）；`v`＝排序值。v1 舊格式一律視為無效。 */
export function encodeStudentCursor(identity: string, after: CursorPosition): string {
  const body: Record<string, unknown> = { version: 2, identity, p: after.personCode };
  if (after.sortValue === null) body.n = true;
  else if (after.sortValue !== undefined) body.v = after.sortValue;
  return Buffer.from(JSON.stringify(body)).toString('base64');
}

export function decodeStudentCursor(cursor: string | undefined, identity: string, sort?: SortSpec): CursorPosition | null {
  if (!cursor) return null;
  try {
    if (cursor.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cursor)) throw new Error();
    const bytes = Buffer.from(cursor, 'base64');
    if (bytes.toString('base64') !== cursor) throw new Error();
    const value = JSON.parse(bytes.toString('utf8'));
    if (value.version !== 2 || value.identity !== identity || typeof value.p !== 'string' || !value.p || value.p.length > 200) throw new Error();
    // 形狀必須與本次 sort 相符：未排序不得帶 v/n；排序則必須恰有 n（null）或 v（文字欄為字串、其餘為有限數值）
    const hasN = 'n' in value, hasV = 'v' in value;
    if (!sort) {
      if (hasN || hasV) throw new Error();
      return { personCode: value.p };
    }
    if (hasN === hasV) throw new Error();
    if (hasN) {
      if (value.n !== true) throw new Error();
      return { personCode: value.p, sortValue: null };
    }
    const text = TEXT_SORT_FIELDS.has(sort.field);
    if (text ? typeof value.v !== 'string' || value.v.length > 200 : typeof value.v !== 'number' || !Number.isFinite(value.v)) throw new Error();
    return { personCode: value.p, sortValue: value.v };
  } catch {
    invalid('cursor', '無效或與本次名冊／條件不符，請從第一頁重查');
  }
}

/**
 * D66 cursor v3（03 §5.1 R8）：keyset 鍵 `(value, text, personCode)`。
 * `cell`：undefined＝未排序（只有 `p`）；null＝空白列（`n: true`）；其餘帶 `v`（數值或字串）與 `t`（顯示文字）。
 */
export interface ColumnCursorPosition { personCode: string; cell?: { value: number | string; text: string } | null }

export function encodeColumnCursor(identity: string, after: ColumnCursorPosition): string {
  const body: Record<string, unknown> = { version: 3, identity, p: after.personCode };
  if (after.cell === null) body.n = true;
  else if (after.cell !== undefined) { body.v = after.cell.value; body.t = after.cell.text; }
  return Buffer.from(JSON.stringify(body)).toString('base64');
}

const COLUMN_CURSOR_KEYS = new Set(['version', 'identity', 'p', 'n', 'v', 't']);

/** `sorted`：本次請求是否帶 sort；形狀必須相符，否則 400 並指名 `cursor`。 */
export function decodeColumnCursor(cursor: string | undefined, identity: string, sorted = true): ColumnCursorPosition | null {
  if (!cursor) return null;
  try {
    if (cursor.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cursor)) throw new Error();
    const bytes = Buffer.from(cursor, 'base64');
    if (bytes.toString('base64') !== cursor) throw new Error();
    const value = JSON.parse(bytes.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    if (Object.keys(value).some((k) => !COLUMN_CURSOR_KEYS.has(k))) throw new Error();
    if (value.version !== 3 || value.identity !== identity || typeof value.p !== 'string' || !value.p || value.p.length > 200) throw new Error();
    const hasN = 'n' in value, hasV = 'v' in value, hasT = 't' in value;
    if (!sorted) {
      if (hasN || hasV || hasT) throw new Error();
      return { personCode: value.p };
    }
    if (hasN) {
      if (value.n !== true || hasV || hasT) throw new Error();
      return { personCode: value.p, cell: null };
    }
    if (!hasV || !hasT) throw new Error();
    const numeric = typeof value.v === 'number' && Number.isFinite(value.v);
    const textual = typeof value.v === 'string' && value.v.length <= 200;
    if (!numeric && !textual) throw new Error();
    if (typeof value.t !== 'string' || value.t.length > 200) throw new Error();
    return { personCode: value.p, cell: { value: value.v, text: value.t } };
  } catch {
    invalid('cursor', '無效或與本次名冊／條件不符，請從第一頁重查');
  }
}
