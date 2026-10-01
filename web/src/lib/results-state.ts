import { normalizeStudentQuery, StudentQueryInputError } from '@/contracts/student-query';
import {
  readResultsUrl, pruneStudentFilters, exactlyOneClass, findStudentField, displayValue,
  STUDENT_FILTER_KEYS, type ResultsUrlState, type OptionsByKey,
} from './results-filters';

export interface ResultsFilterState extends ResultsUrlState {
  invalid: boolean;
  pruned: Array<{ column: string; label: string }>;
}

function dropApplicable(state: ResultsFilterState): void {
  if (!state.filters.applicableDiscountBps || exactlyOneClass(state.filters)) return;
  const field = findStudentField('applicableDiscountBps')!;
  for (const wire of state.filters.applicableDiscountBps) state.pruned.push({ column: field.column, label: displayValue(field, wire) });
  delete state.filters.applicableDiscountBps;
}

/** SSR 與 client Back 還原共用的 URL 解析／合法性判斷；不讀 DB。 */
export function parseResultsState(raw: Parameters<typeof readResultsUrl>[0]): ResultsFilterState {
  const state: ResultsFilterState = { ...readResultsUrl(raw), invalid: false, pruned: [] };
  dropApplicable(state);
  try {
    normalizeStudentQuery(state.filters, new Set(STUDENT_FILTER_KEYS));
  } catch (error) {
    if (!(error instanceof StudentQueryInputError)) throw error;
    state.invalid = true;
    state.filters = {};
  }
  return state;
}

/** 選項不足時只暫緩單班適用率；其他欄一律用 run 的全體選項剪枝。 */
export function pruneResultsState(state: ResultsFilterState, options: OptionsByKey, deferApplicable = false): ResultsFilterState {
  const filters = { ...state.filters };
  const deferred = deferApplicable && exactlyOneClass(filters) ? filters.applicableDiscountBps : undefined;
  if (deferred) delete filters.applicableDiscountBps;
  const result = pruneStudentFilters(filters, options);
  if (deferred) result.filters.applicableDiscountBps = deferred;
  const next = { ...state, filters: result.filters, pruned: [...state.pruned, ...result.removed] };
  dropApplicable(next);
  return next;
}
