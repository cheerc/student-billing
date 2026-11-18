import { StudentQueryInputError } from '@/contracts/student-query';
import { COLUMN_PARAM_PREFIX as COL_PREFIX, parseColumnFilters, type ColumnFilterKeys } from '@/contracts/column-filter';
import { STUDENT_COLUMN_SPECS } from '@/lib/table-columns/student-columns';
import {
  readResultsUrl, pruneStudentFilters, exactlyOneClass, findStudentField, displayValue,
  type ResultsUrlState, type OptionsByKey, type PrunedEntry,
} from './results-filters';

export interface ResultsFilterState extends ResultsUrlState {
  invalid: boolean;
  pruned: PrunedEntry[];
}

/** 與 server `RUN_COLUMN_FILTER_KEYS`（03 §5.1 R6）同源：由同一份欄位定義推得。 */
const COLUMN_KEYS: ColumnFilterKeys = {
  known: new Set(STUDENT_COLUMN_SPECS.map((c) => c.key)),
  filterable: new Set(STUDENT_COLUMN_SPECS.filter((c) => c.filterable).map((c) => c.key)),
};

function dropApplicable(state: ResultsFilterState): void {
  if (!state.filters.applicableDiscount || exactlyOneClass(state.filters)) return;
  const field = findStudentField('applicableDiscount')!;
  for (const wire of state.filters.applicableDiscount) state.pruned.push({ column: field.column, label: displayValue(field, wire) });
  delete state.filters.applicableDiscount;
}

/** SSR 與 client Back 還原共用的 URL 解析／合法性判斷；不讀 DB。舊語意參數一律移除並列入提示（09 §5.1「網址」）。 */
export function parseResultsState(raw: Parameters<typeof readResultsUrl>[0]): ResultsFilterState {
  const url = readResultsUrl(raw);
  const state: ResultsFilterState = { ...url, filters: { ...url.filters }, invalid: false, pruned: [...url.legacy] };
  dropApplicable(state);
  try {
    // 與 server 相同的 col.* 驗證（未知／不可篩選欄、空字串、未跳脫的 ~、~none 並存），錯誤即整組忽略。
    const input: Record<string, string[]> = { ...url.invalidColumns };
    for (const [key, wires] of Object.entries(state.filters)) input[`${COL_PREFIX}${key}`] = wires ?? [];
    parseColumnFilters(input, COLUMN_KEYS);
  } catch (error) {
    if (!(error instanceof StudentQueryInputError)) throw error;
    state.invalid = true;
    state.filters = {};
  }
  return state;
}

/** 選項不足時只暫緩單班適用率；其他欄一律用 run 的全體選項（`columnOptions`）剪枝。 */
export function pruneResultsState(state: ResultsFilterState, options: OptionsByKey, deferApplicable = false): ResultsFilterState {
  const filters = { ...state.filters };
  const deferred = deferApplicable && exactlyOneClass(filters) ? filters.applicableDiscount : undefined;
  if (deferred) delete filters.applicableDiscount;
  const result = pruneStudentFilters(filters, options);
  if (deferred) result.filters.applicableDiscount = deferred;
  const next = { ...state, filters: result.filters, pruned: [...state.pruned, ...result.removed] };
  dropApplicable(next);
  return next;
}
