import type Database from 'better-sqlite3';
import { queryRunStudents, validateRunQueryParams, QueryStudentError, type RunStudentsQueryResult } from './query-students';
import { queryStudentOptions, type RunStudentOptions } from './query-student-options';
import {
  displayValue,
  exactlyOneClass,
  findStudentField,
  pruneStudentFilters,
  readResultsUrl,
  type DeductionFilters,
  type StudentFilters,
} from '@/lib/results-filters';

/**
 * 核對結果頁（現行資料與歷史資料共用）的伺服器端初始狀態（specs/09 §5.1、03 §5.1）。
 *
 * 由網址還原 view 與兩個頁籤各自的條件；條件在這份 run 的整體選項中已不存在時（run 變更、網址過期）
 * 自動移除並回報，網址不合法（例如 hasExtraDeduction=maybe）時忽略全部條件並回報，不讓頁面出錯。
 * 姓名搜尋 q 不在網址，這裡不處理。
 */
export interface ResultsInitialState {
  view: 'students' | 'deductions';
  filters: StudentFilters;
  deductionFilters: DeductionFilters;
  data: RunStudentsQueryResult;
  options: RunStudentOptions;
  /** 網址帶的條件無效而被整組忽略 */
  invalid: boolean;
  /** 因這份資料不存在而被移除的選值 */
  pruned: Array<{ column: string; label: string }>;
}

type RawParams = Record<string, string | string[] | undefined>;

function dropApplicable(filters: StudentFilters, removed: ResultsInitialState['pruned']): void {
  if (!filters.applicableDiscountBps || exactlyOneClass(filters)) return;
  const field = findStudentField('applicableDiscountBps')!;
  for (const w of filters.applicableDiscountBps) removed.push({ column: field.column, label: displayValue(field, w) });
  delete filters.applicableDiscountBps;
}

export function resolveResultsView(db: Database.Database, runId: string, raw: RawParams): ResultsInitialState {
  const url = readResultsUrl(raw);
  let filters: StudentFilters = { ...url.filters };
  let invalid = false;
  const removed: ResultsInitialState['pruned'] = [];

  // 本班適用折扣只在恰選一班時成立，否則不是「無效網址」，而是這個條件已不適用
  dropApplicable(filters, removed);
  try {
    validateRunQueryParams({ ...filters });
  } catch (error) {
    if (!(error instanceof QueryStudentError)) throw error;
    invalid = true;
    filters = {};
  }

  const classParam = filters.enrollmentKey && exactlyOneClass(filters) ? { enrollmentKey: filters.enrollmentKey } : {};
  const options = queryStudentOptions(db, runId, classParam);
  const result = pruneStudentFilters(filters, options.options);
  let pruned = result.filters;
  removed.push(...result.removed);
  dropApplicable(pruned, removed);

  let data: RunStudentsQueryResult;
  try {
    data = queryRunStudents(db, runId, { limit: 50, ...pruned });
  } catch (error) {
    if (!(error instanceof QueryStudentError)) throw error;
    invalid = true;
    pruned = {};
    data = queryRunStudents(db, runId, { limit: 50 });
  }

  return {
    view: url.view,
    filters: pruned,
    deductionFilters: url.deductionFilters,
    data,
    options,
    invalid,
    pruned: removed,
  };
}
