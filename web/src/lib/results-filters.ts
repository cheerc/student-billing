/**
 * 核對結果的表頭篩選資料模型（specs/09 §5.1／§5.2、03 §5.1；D36、D66）。純函式，client／server 共用。
 *
 * 學生總表條件（D66）：以 columnKey 為鍵、值為該欄儲存格的**顯示文字**（wire 值），與網址 `col.<columnKey>`、
 * API 的 `col.<columnKey>` 完全同形（03 §5.1 R7）：
 *   - 未設篩選：該欄沒有 key（`undefined`）
 *   - `~blank`：(空白)；`['~none']`：取消全選（0 筆，只能單獨出現）
 *   - 字面以 `~` 開頭的顯示文字，前置一個 `~` 跳脫（`~~x`＝字面 `~x`）
 * 多值以重複 key 傳送；同欄 OR、跨欄 AND。班級扣天頁籤的條件（`dClass`／`dTeacher`／`dStatus`）規則不變。
 */

import { ISSUE_LABELS } from '@/lib/issue-copy';
import { STUDENT_SORT_FIELDS } from '@/contracts/student-sort-fields';
import { UNPARSEABLE_CLASS_TEXT } from '@/contracts/column-filter';

export const BLANK = '~blank';
export const NONE = '~none';

/** 與 `STUDENT_COLUMN_SPECS` 中可篩選欄的 columnKey 相同（03 §5.1 R6）。 */
export type StudentFilterKey =
  | 'enrollment'
  | 'grade'
  | 'anqinDays'
  | 'tutoringDays'
  | 'extraDeduction'
  | 'baseDiscount'
  | 'applicableDiscount'
  | 'sibling'
  | 'specialDiscount'
  | 'internalStudent'
  | 'review';

export type DeductionFilterKey = 'dClass' | 'dTeacher' | 'dStatus';

export interface FilterFieldDef<K extends string = string> {
  key: K;
  /** 條件 chip 與欄位表頭使用的欄名 */
  column: string;
}

/** 欄序即 chip 順序；欄名同 `STUDENT_COLUMN_SPECS` 的表頭名稱（本班適用折扣緊接合計折扣）。 */
export const STUDENT_FILTER_FIELDS: ReadonlyArray<FilterFieldDef<StudentFilterKey>> = [
  { key: 'enrollment', column: '所屬班級' },
  { key: 'grade', column: '年級' },
  { key: 'anqinDays', column: '安親天數' },
  { key: 'tutoringDays', column: '課輔天數' },
  { key: 'extraDeduction', column: '額外扣天' },
  { key: 'baseDiscount', column: '合計折扣' },
  { key: 'applicableDiscount', column: '本班適用折扣' },
  { key: 'sibling', column: '兄弟姊妹折扣' },
  { key: 'specialDiscount', column: '特殊折扣' },
  { key: 'internalStudent', column: '園內生' },
  { key: 'review', column: '需確認' },
];

export const DEDUCTION_FILTER_FIELDS: ReadonlyArray<FilterFieldDef<DeductionFilterKey>> = [
  { key: 'dClass', column: '班級' },
  { key: 'dTeacher', column: '老師' },
  { key: 'dStatus', column: '狀態' },
];

export const STUDENT_FILTER_KEYS = STUDENT_FILTER_FIELDS.map((f) => f.key);
export const DEDUCTION_FILTER_KEYS = DEDUCTION_FILTER_FIELDS.map((f) => f.key);

export type StudentFilters = Partial<Record<StudentFilterKey, string[]>>;
export type DeductionFilters = Partial<Record<DeductionFilterKey, string[]>>;

export { ISSUE_LABELS };

export const findStudentField = (key: string) => STUDENT_FILTER_FIELDS.find((f) => f.key === key);

/** 網址／API 的學生欄參數前綴（03 §5.1 R7）。 */
export const COLUMN_PARAM_PREFIX = 'col.';
/** 保留值：舊版「班名無法解析」wire；僅供 chip 顯示舊值，col.* 已不接受（它現在是一般顯示文字）。 */
const LEGACY_EMPTY = '~empty';

/**
 * 舊語意參數（API 仍為 Agent 保留）：網址載入時一律移除並提示（09 §5.1「網址」）。順序即提示順序。
 * 欄名取自對應的 col.* 欄位。
 */
export const LEGACY_STUDENT_PARAMS: ReadonlyArray<{ param: string; column: string }> = [
  { param: 'enrollmentKey', column: '所屬班級' },
  { param: 'grade', column: '年級' },
  { param: 'anqinDays', column: '安親天數' },
  { param: 'tutoringDays', column: '課輔天數' },
  { param: 'hasExtraDeduction', column: '額外扣天' },
  { param: 'baseDiscountBps', column: '合計折扣' },
  { param: 'applicableDiscountBps', column: '本班適用折扣' },
  { param: 'sibling', column: '兄弟姊妹折扣' },
  { param: 'specialDiscount', column: '特殊折扣' },
  { param: 'internalStudent', column: '園內生' },
  { param: 'tierMismatch', column: '需確認' },
  { param: 'issueCode', column: '需確認' },
];

/** wire 值 → 字面值（`~~x` → `~x`）；保留字原樣回傳。 */
export function unescapeWire(wire: string): string {
  return wire.startsWith('~~') ? wire.slice(1) : wire;
}

/** 字面值 → wire 值（字面以 `~` 開頭者前置跳脫）。 */
export function escapeLiteral(value: string): string {
  return value.startsWith('~') ? `~${value}` : value;
}

/**
 * `columnOptions` 的選項值（顯示文字或 `~blank`）→ 篩選 wire 值。
 * `~blank` 是保留值原樣；其餘為顯示文字，字面以 `~` 開頭者前置跳脫。
 */
export function optionWire(value: string): string {
  return value === BLANK ? BLANK : escapeLiteral(value);
}

/** 與 formatDiscountBps 相同的短標（10000 無折扣；整十收取率「N折」；其餘 bps/100 折）。 */
export function discountLabel(bps: number): string {
  if (bps === 10000) return '無折扣';
  const tenths = bps / 1000;
  return Number.isInteger(tenths) ? `${tenths}折` : `${bps / 100}折`;
}

/**
 * 選項與 chip 顯示的名稱：wire 值本身就是儲存格顯示文字（D66），只還原保留值與跳脫。
 * `~blank` 一律是「(空白)」，不是空字串。
 */
export function displayValue(_field: Pick<FilterFieldDef, 'key'>, wire: string): string {
  if (wire === BLANK) return '(空白)';
  if (wire === LEGACY_EMPTY) return UNPARSEABLE_CLASS_TEXT;
  if (wire === NONE) return '已取消全選';
  return unescapeWire(wire);
}

export { STUDENT_SORT_FIELDS };

/** 網址／API 的 sort 值：`<field>` 或 `-<field>`；不在白名單者視為未排序。 */
export function parseSortWire(wire: string | undefined | null): { field: string; dir: 'asc' | 'desc' } | null {
  if (!wire) return null;
  const desc = wire.startsWith('-');
  const field = desc ? wire.slice(1) : wire;
  return STUDENT_SORT_FIELDS.includes(field) ? { field, dir: desc ? 'desc' : 'asc' } : null;
}

export interface PrunedEntry {
  /** 欄名 */
  column: string;
  /** 顯示名稱 */
  label: string;
}

export interface ResultsUrlState {
  view: 'students' | 'deductions';
  runId: string | null;
  /** 學生總表排序（wire 值，null＝預設 person_code 序） */
  sort: string | null;
  /** 學生總表條件（col.<key> 的 wire 值，原樣讀入、尚未驗證；驗證在 `parseResultsState`） */
  filters: StudentFilters;
  deductionFilters: DeductionFilters;
  /** 被移除的舊語意參數（每個值一筆，供提示用；不再寫回網址） */
  legacy: PrunedEntry[];
  /** 網址中未知或不可篩選的 `col.<key>`（原樣保留供驗證回報無效）；正常為空 */
  invalidColumns: Record<string, string[]>;
}

type RawParams = URLSearchParams | Record<string, string | string[] | undefined>;

function allOf(raw: RawParams, key: string): string[] {
  if (raw instanceof URLSearchParams) return raw.getAll(key);
  const v = raw[key];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function keysOf(raw: RawParams): string[] {
  return raw instanceof URLSearchParams ? [...new Set(raw.keys())] : Object.keys(raw);
}

/** 班級扣天條件：空字串是舊版的「未設」寫法，不當條件；`~none` 單獨成立（行為不變）。 */
function readDeductionSelection(raw: RawParams): DeductionFilters {
  const out: DeductionFilters = {};
  for (const f of DEDUCTION_FILTER_FIELDS) {
    const wires = allOf(raw, f.key).filter((w) => w !== '');
    if (wires.length === 0) continue;
    out[f.key] = wires.includes(NONE) ? [NONE] : [...new Set(wires)];
  }
  return out;
}

/** 從網址讀取 view／runId／兩個頁籤的條件（不含姓名搜尋；q 不入網址）。 */
export function readResultsUrl(raw: RawParams): ResultsUrlState {
  const view = allOf(raw, 'view')[0] === 'deductions' ? 'deductions' : 'students';
  const filters: StudentFilters = {};
  const invalidColumns: Record<string, string[]> = {};
  const known = new Set<string>(STUDENT_FILTER_KEYS);
  for (const param of keysOf(raw)) {
    if (!param.startsWith(COLUMN_PARAM_PREFIX)) continue;
    const key = param.slice(COLUMN_PARAM_PREFIX.length);
    const wires = allOf(raw, param);
    if (wires.length === 0) continue;
    // 重複 key 去重但不改寫值：空字串、`~none` 並存等無效形狀留待 parseResultsState 驗證。
    if (known.has(key)) filters[key as StudentFilterKey] = [...new Set(wires)];
    else invalidColumns[param] = wires;
  }
  const legacy: PrunedEntry[] = [];
  for (const { param, column } of LEGACY_STUDENT_PARAMS) {
    for (const wire of allOf(raw, param)) legacy.push({ column, label: wire === '' ? '(空值)' : displayValue({ key: param }, wire) });
  }
  return {
    view,
    runId: allOf(raw, 'runId')[0] || null,
    sort: parseSortWire(allOf(raw, 'sort')[0]) ? allOf(raw, 'sort')[0] : null,
    filters,
    deductionFilters: readDeductionSelection(raw),
    legacy,
    invalidColumns,
  };
}

/** 條件 → 參數：學生欄鍵為 `col.<key>`；班級扣天條件原鍵（`dClass` 等）。 */
export function selectionsToParams(selections: Record<string, string[] | undefined>, into: URLSearchParams = new URLSearchParams(), prefix = ''): URLSearchParams {
  for (const [key, wires] of Object.entries(selections)) {
    for (const w of wires ?? []) into.append(`${prefix}${key}`, w);
  }
  return into;
}

/** 學生條件 → server 查詢參數物件（`col.<key>` 重複值）；SSR 直接呼叫 application 層時使用。 */
export function studentFiltersToParams(filters: StudentFilters): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, wires] of Object.entries(filters)) {
    if (wires && wires.length > 0) out[`${COLUMN_PARAM_PREFIX}${key}`] = [...wires];
  }
  return out;
}

/** 目前頁面網址的查詢字串：view、runId、學生條件（col.*）、班級扣天條件（各自獨立，互不作用）。 */
export function buildResultsQuery(state: Pick<ResultsUrlState, 'view' | 'runId' | 'sort' | 'filters' | 'deductionFilters'> & Partial<Pick<ResultsUrlState, 'legacy' | 'invalidColumns'>>): string {
  const params = new URLSearchParams();
  params.set('view', state.view);
  if (state.runId) params.set('runId', state.runId);
  if (state.sort) params.set('sort', state.sort);
  selectionsToParams(state.filters, params, COLUMN_PARAM_PREFIX);
  selectionsToParams(state.deductionFilters, params);
  return params.toString();
}

/** 呼叫 GET /runs/{id}/students 的參數（姓名搜尋 q 只放這裡，不入網址）。 */
export function buildStudentApiParams(filters: StudentFilters, q: string, extra: Record<string, string> = {}): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  selectionsToParams(filters, params, COLUMN_PARAM_PREFIX);
  if (q.trim()) params.set('q', q.trim());
  return params;
}

export function hasAnySelection(selections: Record<string, string[] | undefined>): boolean {
  return Object.values(selections).some((w) => (w?.length ?? 0) > 0);
}

/**
 * 恰選一個真實班級（不含 (空白)／班名無法解析／取消全選）時回傳班名（名冊班名），否則 null——本班適用折扣只在此時出現。
 * 與 server `resolveSingleClassName`（03 §5.1 R7）同判：班名無法解析不是真實班名。
 */
export function exactlyOneClass(filters: StudentFilters): string | null {
  const wires = filters.enrollment;
  if (!wires || wires.length !== 1) return null;
  const w = wires[0];
  if (w === BLANK || w === NONE || w === LEGACY_EMPTY || w === UNPARSEABLE_CLASS_TEXT) return null;
  return unescapeWire(w);
}

export type ScopeKind = 'all' | 'single' | 'multi' | 'special' | 'none';

/** 人數行的範圍：全部／本班（恰選一班）／已選 N 班（多選）／單一保留項目／取消全選。 */
export function scopeOf(filters: StudentFilters): { kind: ScopeKind; count: number; special?: string } {
  const wires = filters.enrollment;
  if (!wires || wires.length === 0) return { kind: 'all', count: 0 };
  if (wires[0] === NONE) return { kind: 'none', count: 0 };
  if (wires.length === 1) {
    if (wires[0] === BLANK) return { kind: 'special', count: 1, special: '(空白)' };
    if (wires[0] === UNPARSEABLE_CLASS_TEXT) return { kind: 'special', count: 1, special: UNPARSEABLE_CLASS_TEXT };
    return { kind: 'single', count: 1 };
  }
  return { kind: 'multi', count: wires.length };
}

/** 面板少雜訊，但0人仍是合法值；已勾選者保留供取消，不影響 prune。 */
export function visibleFilterOptions<T extends { value: string; count?: number }>(options: T[], selected: string[]): T[] {
  const checked = new Set(selected);
  return options.filter((option) => option.count !== 0 || checked.has(option.value));
}

export interface OptionLike { value: string; count?: number }
export type OptionsByKey = Record<string, OptionLike[] | undefined>;

export interface PruneResult<F> {
  filters: F;
  /** 被移除的值：欄名＋顯示名稱（供提示用） */
  removed: PrunedEntry[];
}

/**
 * run 變更或網址過期時，移除這份資料中已不存在的選值（09 §5.1）。`options` 為 `columnOptions`（顯示文字／`~blank`）。
 * `~none` 永遠保留（它不是資料值）；本班適用折扣只在恰選一班時有意義，否則整欄移除。
 */
export function pruneStudentFilters(filters: StudentFilters, options: OptionsByKey): PruneResult<StudentFilters> {
  const next: StudentFilters = {};
  const removed: PrunedEntry[] = [];
  const oneClass = exactlyOneClass(filters);
  for (const field of STUDENT_FILTER_FIELDS) {
    const wires = filters[field.key];
    if (!wires || wires.length === 0) continue;
    if (wires[0] === NONE) {
      next[field.key] = wires;
      continue;
    }
    if (field.key === 'applicableDiscount' && !oneClass) {
      for (const w of wires) removed.push({ column: field.column, label: displayValue(field, w) });
      continue;
    }
    const known = new Set((options[field.key] ?? []).map((o) => optionWire(o.value)));
    const kept = wires.filter((w) => known.has(w));
    for (const w of wires.filter((x) => !kept.includes(x))) removed.push({ column: field.column, label: displayValue(field, w) });
    if (kept.length > 0) next[field.key] = kept;
  }
  return { filters: next, removed };
}

const sameSet = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
  const x = new Set(a ?? []);
  const y = new Set(b ?? []);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

/**
 * 套用面板／chip 的新條件：丟掉空陣列；本班適用折扣只在恰選一班時有意義，**且班級選取任何改變（加／減／換）都清掉它**。
 * 理由（P3a 審查帶入）：帶 `col.applicableDiscount` 時，server 的 `columnOptions.enrollment` 以已選班的適用折扣範圍
 * 計數其他候選班；不清掉就會在過期的折扣條件下顯示跨班計數。
 */
export function reconcileStudentFilters(
  prev: StudentFilters,
  next: StudentFilters
): { filters: StudentFilters; removedApplicable: 'not-single' | 'class-changed' | null } {
  const merged: StudentFilters = {};
  for (const [k, v] of Object.entries(next)) {
    if (v && v.length > 0) merged[k as StudentFilterKey] = v;
  }
  let removedApplicable: 'not-single' | 'class-changed' | null = null;
  if (merged.applicableDiscount) {
    if (!exactlyOneClass(merged)) removedApplicable = 'not-single';
    else if (!sameSet(prev.enrollment, merged.enrollment)) removedApplicable = 'class-changed';
    if (removedApplicable) delete merged.applicableDiscount;
  }
  return { filters: merged, removedApplicable };
}

/** 條件 chip（欄名＋值），供表格上方顯示與逐一移除。 */
export interface FilterChip {
  key: string;
  column: string;
  label: string;
  /** 移除此 chip 後該欄剩下的 wire；空陣列＝整欄清除 */
  remaining: string[];
}

export function chipsOf<K extends string>(
  selections: Partial<Record<K, string[]>>,
  fields: ReadonlyArray<FilterFieldDef<K>>
): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const f of fields) {
    const wires = selections[f.key];
    if (!wires || wires.length === 0) continue;
    for (const w of wires) {
      chips.push({ key: f.key, column: f.column, label: displayValue(f, w), remaining: wires.filter((x) => x !== w) });
    }
  }
  return chips;
}
