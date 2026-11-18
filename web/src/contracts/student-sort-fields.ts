/**
 * D65：學生查詢可排序欄的單一來源（純資料、無 Node 依賴，server 與 client 皆可 import）。
 * field（wire 名）→ 實體欄名。`/runs/{id}/students` 與 `/imports/{id}/students` 各有白名單；
 * `RUN_SORT_COLUMNS` 的實體欄名只剩 key 白名單用途（D66 起 runs 端點不再以 SQL 排序）；匯入預覽（roster-query）仍用 `IMPORT_SORT_COLUMNS` 的 SQL 排序，`name` 為 BINARY 碼點序。
 */
export const RUN_SORT_COLUMNS: Readonly<Record<string, string>> = {
  name: 'name', grade: 'grade', anqinDays: 'anqin_days', tutoringDays: 'tutoring_days', baseDiscountBps: 'base_discount_bps', subjectCount: 'subject_count',
};
/** D66：`/runs/{id}/students` 的 sort 欄位 → 學生總表 columnKey（排序走 application 層 compareCells，與儲存格同源）。 */
export const RUN_SORT_COLUMN_KEYS: Readonly<Record<string, string>> = {
  name: 'name', grade: 'grade', anqinDays: 'anqinDays', tutoringDays: 'tutoringDays', baseDiscountBps: 'baseDiscount', subjectCount: 'subjectCount',
};
export const IMPORT_SORT_COLUMNS: Readonly<Record<string, string>> = { name: 'name', grade: 'grade' };
export const TEXT_SORT_FIELDS: ReadonlySet<string> = new Set(['name']);

/** 學生總表可排序欄（client 表頭與網址白名單；與 server RUN_SORT_COLUMNS 同源）。 */
export const STUDENT_SORT_FIELDS: readonly string[] = Object.keys(RUN_SORT_COLUMNS);
