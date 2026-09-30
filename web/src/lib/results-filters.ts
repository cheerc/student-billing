/**
 * 核對結果的表頭篩選資料模型（specs/09 §5.1／§5.2、03 §5.1；D36）。純函式，client／server 共用。
 *
 * 條件以 API 的 wire 值表示，與網址、API 完全同形（03 §5.1）：
 *   - 未設篩選：該欄沒有 key（`undefined`）
 *   - `~blank`：(空白)；`~empty`：班名無法解析（僅所屬班級）；`['~none']`：取消全選（0 筆，只能單獨出現）
 *   - 字面以 `~` 開頭的值，前置一個 `~` 跳脫（`~~x`＝字面 `~x`）
 * 多值以重複 key 傳送；同欄 OR、跨欄 AND。
 */

export const BLANK = '~blank';
export const EMPTY = '~empty';
export const NONE = '~none';

export type StudentFilterKey =
  | 'enrollmentKey'
  | 'grade'
  | 'anqinDays'
  | 'tutoringDays'
  | 'hasExtraDeduction'
  | 'baseDiscountBps'
  | 'applicableDiscountBps'
  | 'sibling'
  | 'specialDiscount'
  | 'internalStudent'
  | 'tierMismatch'
  | 'issueCode';

export type DeductionFilterKey = 'dClass' | 'dTeacher' | 'dStatus';

export type FilterKind = 'string' | 'number' | 'bps' | 'boolean';

export interface FilterFieldDef<K extends string = string> {
  key: K;
  /** 條件 chip 與欄位表頭使用的欄名 */
  column: string;
  /** 多分區面板（需確認）內的分區名；單一欄位面板不顯示 */
  section?: string;
  kind: FilterKind;
  /** boolean 欄位的顯示名稱 */
  booleanLabels?: { true: string; false: string };
}

export const STUDENT_FILTER_FIELDS: ReadonlyArray<FilterFieldDef<StudentFilterKey>> = [
  { key: 'enrollmentKey', column: '所屬班級', kind: 'string' },
  { key: 'grade', column: '年級', kind: 'number' },
  { key: 'anqinDays', column: '安親天數', kind: 'number' },
  { key: 'tutoringDays', column: '課輔天數', kind: 'number' },
  { key: 'hasExtraDeduction', column: '額外扣天', kind: 'boolean', booleanLabels: { true: '有', false: '無' } },
  { key: 'baseDiscountBps', column: '合計折扣', kind: 'bps' },
  { key: 'applicableDiscountBps', column: '本班適用折扣', kind: 'bps' },
  { key: 'sibling', column: '兄弟姊妹折扣', kind: 'boolean', booleanLabels: { true: '有', false: '無' } },
  { key: 'specialDiscount', column: '特殊折扣', kind: 'boolean', booleanLabels: { true: '有', false: '無' } },
  { key: 'internalStudent', column: '園內生', kind: 'boolean', booleanLabels: { true: '是', false: '否' } },
  { key: 'tierMismatch', column: '需確認', section: '米豆奶天數比較', kind: 'boolean', booleanLabels: { true: '天數不同', false: '天數吻合' } },
  { key: 'issueCode', column: '需確認', section: '問題類型', kind: 'string' },
];

export const DEDUCTION_FILTER_FIELDS: ReadonlyArray<FilterFieldDef<DeductionFilterKey>> = [
  { key: 'dClass', column: '班級', kind: 'string' },
  { key: 'dTeacher', column: '老師', kind: 'string' },
  { key: 'dStatus', column: '狀態', kind: 'string' },
];

export const STUDENT_FILTER_KEYS = STUDENT_FILTER_FIELDS.map((f) => f.key);
export const DEDUCTION_FILTER_KEYS = DEDUCTION_FILTER_FIELDS.map((f) => f.key);

export type StudentFilters = Partial<Record<StudentFilterKey, string[]>>;
export type DeductionFilters = Partial<Record<DeductionFilterKey, string[]>>;

/** 問題類型只顯示中文名稱（D39 第 4 點）；代碼留在明細技術資訊。 */
export const ISSUE_LABELS: Record<string, string> = {
  SCHEDULE_NOT_FOUND: '排課缺漏',
  DUPLICATE_SUBJECT_ENROLLMENT: '重複報名',
  STAFF_FAMILY_NO_DISCOUNT: '員工家屬無折扣',
  CONFLICTING_NOTE_SOURCE: '備註衝突',
  NUMERIC_POLICY_DIFFERENCE: '數值政策差異',
  SCHEDULE_EMPTY: '排課空時段',
  SCHEDULE_INCOMPLETE: '排課時段不完整',
  UNKNOWN_WEEKDAY: '未知星期',
};

export const findStudentField = (key: string) => STUDENT_FILTER_FIELDS.find((f) => f.key === key);

/** wire 值 → 字面值（`~~x` → `~x`）；保留字原樣回傳。 */
export function unescapeWire(wire: string): string {
  return wire.startsWith('~~') ? wire.slice(1) : wire;
}

/** 字面值 → wire 值（字面以 `~` 開頭者前置跳脫）。 */
export function escapeLiteral(value: string): string {
  return value.startsWith('~') ? `~${value}` : value;
}

/** 數值欄的 wire 統一成 Number 的字串形式（'3.50' 與 '3.5' 視為同值）。 */
export function canonicalWire(field: Pick<FilterFieldDef, 'kind'>, wire: string): string {
  if (wire.startsWith('~')) return wire;
  if ((field.kind === 'number' || field.kind === 'bps') && wire.trim() !== '' && Number.isFinite(Number(wire))) {
    return String(Number(wire));
  }
  return wire;
}

/** 與 formatDiscountBps 相同的短標（10000 無折扣；整十收取率「N折」；其餘 bps/100 折）。 */
export function discountLabel(bps: number): string {
  if (bps === 10000) return '無折扣';
  const tenths = bps / 1000;
  return Number.isInteger(tenths) ? `${tenths}折` : `${bps / 100}折`;
}

/** 選項與 chip 顯示的名稱；`~empty` 一律是「班名無法解析」，`~blank` 一律是「(空白)」，兩者不同形也不是空字串。 */
export function displayValue(field: Pick<FilterFieldDef, 'kind' | 'booleanLabels' | 'key'>, wire: string): string {
  if (wire === BLANK) return '(空白)';
  if (wire === EMPTY) return '班名無法解析';
  if (wire === NONE) return '已取消全選';
  const literal = unescapeWire(wire);
  if (field.kind === 'boolean') return field.booleanLabels?.[literal as 'true' | 'false'] ?? literal;
  if (field.kind === 'bps') return Number.isFinite(Number(literal)) ? discountLabel(Number(literal)) : literal;
  if (field.key === 'grade') return `${literal}年級`;
  if (field.key === 'issueCode') return ISSUE_LABELS[literal] ?? literal;
  return literal;
}

/** 選項排序：保留項目在最上（好找），其餘數值欄依數值、文字欄依字串。 */
export function compareOptionValues(field: Pick<FilterFieldDef, 'kind'>, a: string, b: string): number {
  const rank = (w: string) => (w === BLANK ? 0 : w === EMPTY ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (field.kind === 'number' || field.kind === 'bps') return Number(a) - Number(b);
  if (field.kind === 'boolean') return a === 'true' ? -1 : b === 'true' ? 1 : 0;
  return a.localeCompare(b, 'zh-Hant');
}

export interface ResultsUrlState {
  view: 'students' | 'deductions';
  runId: string | null;
  filters: StudentFilters;
  deductionFilters: DeductionFilters;
}

type RawParams = URLSearchParams | Record<string, string | string[] | undefined>;

function allOf(raw: RawParams, key: string): string[] {
  if (raw instanceof URLSearchParams) return raw.getAll(key);
  const v = raw[key];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function readSelection<K extends string>(raw: RawParams, fields: ReadonlyArray<FilterFieldDef<K>>): Partial<Record<K, string[]>> {
  const out: Partial<Record<K, string[]>> = {};
  for (const f of fields) {
    // 空字串是舊版的「未設」寫法，不當條件
    const wires = allOf(raw, f.key).filter((w) => w !== '');
    if (wires.length === 0) continue;
    out[f.key] = wires.includes(NONE) ? [NONE] : [...new Set(wires.map((w) => canonicalWire(f, w)))];
  }
  return out;
}

/** 從網址讀取 view／runId／兩個頁籤的條件（不含姓名搜尋；q 不入網址）。 */
export function readResultsUrl(raw: RawParams): ResultsUrlState {
  const view = allOf(raw, 'view')[0] === 'deductions' ? 'deductions' : 'students';
  return {
    view,
    runId: allOf(raw, 'runId')[0] || null,
    filters: readSelection(raw, STUDENT_FILTER_FIELDS),
    deductionFilters: readSelection(raw, DEDUCTION_FILTER_FIELDS),
  };
}

export function selectionsToParams(selections: Record<string, string[] | undefined>, into: URLSearchParams = new URLSearchParams()): URLSearchParams {
  for (const [key, wires] of Object.entries(selections)) {
    for (const w of wires ?? []) into.append(key, w);
  }
  return into;
}

/** 目前頁面網址的查詢字串：view、runId、學生條件、班級扣天條件（各自獨立，互不作用）。 */
export function buildResultsQuery(state: ResultsUrlState): string {
  const params = new URLSearchParams();
  params.set('view', state.view);
  if (state.runId) params.set('runId', state.runId);
  selectionsToParams(state.filters, params);
  selectionsToParams(state.deductionFilters, params);
  return params.toString();
}

/** 呼叫 GET /runs/{id}/students 的參數（姓名搜尋 q 只放這裡，不入網址）。 */
export function buildStudentApiParams(filters: StudentFilters, q: string, extra: Record<string, string> = {}): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  selectionsToParams(filters, params);
  if (q.trim()) params.set('q', q.trim());
  return params;
}

export function hasAnySelection(selections: Record<string, string[] | undefined>): boolean {
  return Object.values(selections).some((w) => (w?.length ?? 0) > 0);
}

/** 恰選一個真實班級（不含 (空白)／班名無法解析／取消全選）時回傳班名，否則 null——本班適用折扣只在此時出現。 */
export function exactlyOneClass(filters: StudentFilters): string | null {
  const wires = filters.enrollmentKey;
  if (!wires || wires.length !== 1) return null;
  const w = wires[0];
  if (w === BLANK || w === EMPTY || w === NONE) return null;
  return unescapeWire(w);
}

export type ScopeKind = 'all' | 'single' | 'multi' | 'special' | 'none';

/** 人數行的範圍：全部／本班（恰選一班）／已選 N 班（多選）／單一保留項目／取消全選。 */
export function scopeOf(filters: StudentFilters): { kind: ScopeKind; count: number; special?: string } {
  const wires = filters.enrollmentKey;
  if (!wires || wires.length === 0) return { kind: 'all', count: 0 };
  if (wires[0] === NONE) return { kind: 'none', count: 0 };
  if (wires.length === 1) {
    if (wires[0] === BLANK) return { kind: 'special', count: 1, special: '(空白)' };
    if (wires[0] === EMPTY) return { kind: 'special', count: 1, special: '班名無法解析' };
    return { kind: 'single', count: 1 };
  }
  return { kind: 'multi', count: wires.length };
}

export interface OptionLike { value: string }
export type OptionsByKey = Record<string, OptionLike[] | undefined>;

export interface PruneResult<F> {
  filters: F;
  /** 被移除的值：欄名＋顯示名稱（供提示用） */
  removed: Array<{ column: string; label: string }>;
}

/**
 * run 變更或網址過期時，移除這份資料中已不存在的選值（09 §5.1）。
 * `~none` 永遠保留（它不是資料值）；本班適用折扣只在恰選一班時有意義，否則整欄移除。
 */
export function pruneStudentFilters(filters: StudentFilters, options: OptionsByKey): PruneResult<StudentFilters> {
  const next: StudentFilters = {};
  const removed: PruneResult<StudentFilters>['removed'] = [];
  const oneClass = exactlyOneClass(filters);
  for (const field of STUDENT_FILTER_FIELDS) {
    const wires = filters[field.key];
    if (!wires || wires.length === 0) continue;
    if (wires[0] === NONE) {
      next[field.key] = wires;
      continue;
    }
    if (field.key === 'applicableDiscountBps' && !oneClass) {
      for (const w of wires) removed.push({ column: field.column, label: displayValue(field, w) });
      continue;
    }
    const known = new Set((options[field.key] ?? []).map((o) => canonicalWire(field, o.value)));
    const kept = wires.filter((w) => known.has(canonicalWire(field, w)));
    for (const w of wires.filter((x) => !kept.includes(x))) removed.push({ column: field.column, label: displayValue(field, w) });
    if (kept.length > 0) next[field.key] = kept;
  }
  return { filters: next, removed };
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
