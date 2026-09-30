import { createHash } from 'crypto';

export type QueryValue = string | number | boolean | null;
export type StudentQueryInput = Record<string, any>;
export interface QuerySelection { values: QueryValue[]; none: boolean }
export interface NormalizedStudentQuery {
  selections: Record<string, QuerySelection>;
  q?: string;
  subject?: string;
  careType?: 'anqin' | 'tutoring';
  runId?: string;
  cursor?: string;
  limit: number;
  options: boolean;
}

export class StudentQueryInputError extends Error {
  statusCode = 400;
}

export const KNOWN_ISSUE_CODES = new Set([
  'DUPLICATE_SUBJECT_ENROLLMENT', 'STAFF_FAMILY_NO_DISCOUNT', 'CONFLICTING_NOTE_SOURCE',
  'NUMERIC_POLICY_DIFFERENCE', 'SCHEDULE_NOT_FOUND', 'SCHEDULE_EMPTY', 'SCHEDULE_INCOMPLETE', 'UNKNOWN_WEEKDAY',
]);
export const VALID_TIER_COMPARISONS = new Set(['match', 'mismatch', 'not_applicable', 'unavailable']);

const BOOLEAN_KEYS = new Set(['hasClass', 'sibling', 'specialDiscount', 'internalStudent', 'hasExtraDeduction', 'hasIssues', 'tierMismatch']);
const INTEGER_KEYS = new Set(['grade', 'baseDiscountBps', 'applicableDiscountBps']);
const NUMBER_KEYS = new Set(['anqinDays', 'tutoringDays', 'billingTier', 'erpBillingTier']);
const SINGLE_KEYS = new Set(['q', 'subject', 'careType', 'runId', 'cursor', 'limit', 'options', 'billingTier']);

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

export function normalizeStudentQuery(input: StudentQueryInput, allowed: ReadonlySet<string>): NormalizedStudentQuery {
  const result: NormalizedStudentQuery = { selections: {}, limit: 50, options: false };
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) invalid(key, '未知或不支援');
    if (['sort', 'scheduleStatus', 'mappingStatus'].includes(key)) invalid(key, '尚未實作，請勿指定');
    const source = input[key];
    if (source === undefined || source === null) continue;
    const raw = (Array.isArray(source) ? source : [source]).map(String);
    if (SINGLE_KEYS.has(key) && raw.length > 1) invalid(key, '只能指定一次');
    if (key === 'limit') {
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

export function queryIdentity(scope: string, query: NormalizedStudentQuery): string {
  const filters = Object.fromEntries(Object.entries(query.selections).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify({ scope, filters, q: query.q || '', subject: query.subject || '', careType: query.careType || '' })).digest('hex');
}

export function encodeStudentCursor(identity: string, after: string): string {
  return Buffer.from(JSON.stringify({ version: 1, identity, after })).toString('base64');
}

export function decodeStudentCursor(cursor: string | undefined, identity: string): string | null {
  if (!cursor) return null;
  try {
    if (cursor.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cursor)) throw new Error();
    const bytes = Buffer.from(cursor, 'base64');
    if (bytes.toString('base64') !== cursor) throw new Error();
    const value = JSON.parse(bytes.toString('utf8'));
    if (value.version !== 1 || value.identity !== identity || typeof value.after !== 'string' || !value.after || value.after.length > 200) throw new Error();
    return value.after;
  } catch {
    invalid('cursor', '無效或與本次名冊／條件不符，請從第一頁重查');
  }
}
