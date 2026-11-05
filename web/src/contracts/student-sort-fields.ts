/**
 * D65：學生查詢可排序欄的單一來源（純資料、無 Node 依賴，server 與 client 皆可 import）。
 * field（wire 名）→ 實體欄名。`/runs/{id}/students` 與 `/imports/{id}/students` 各有白名單；
 * 文字欄只有 `name`（SQLite BINARY 碼點序，非 zh-Hant，C1），其餘皆為數值欄。
 */
export const RUN_SORT_COLUMNS: Readonly<Record<string, string>> = {
  name: 'name', grade: 'grade', anqinDays: 'anqin_days', tutoringDays: 'tutoring_days', baseDiscountBps: 'base_discount_bps', subjectCount: 'subject_count',
};
export const IMPORT_SORT_COLUMNS: Readonly<Record<string, string>> = { name: 'name', grade: 'grade' };
export const TEXT_SORT_FIELDS: ReadonlySet<string> = new Set(['name']);

/** 學生總表可排序欄（client 表頭與網址白名單；與 server RUN_SORT_COLUMNS 同源）。 */
export const STUDENT_SORT_FIELDS: readonly string[] = Object.keys(RUN_SORT_COLUMNS);
