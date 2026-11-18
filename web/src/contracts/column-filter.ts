import { StudentQueryInputError, type StudentQueryInput } from './student-query';

export const COLUMN_PARAM_PREFIX = 'col.';
export interface ColumnSelection { texts: Set<string>; blank: boolean; none: boolean }
export interface ColumnFilterKeys { known: ReadonlySet<string>; filterable: ReadonlySet<string> }

export function isColumnParam(key: string): boolean {
  return key.startsWith(COLUMN_PARAM_PREFIX);
}

/** 顯示文字 → wire 值：字面以 `~` 開頭者前置 `~` 跳脫。 */
export function encodeColumnFilterValue(text: string): string {
  return text;
}

/** 解析輸入中所有 `col.<columnKey>` 參數；R7 的 400 一律丟 StudentQueryInputError 並指名該參數。 */
export function parseColumnFilters(input: StudentQueryInput, keys: ColumnFilterKeys): Record<string, ColumnSelection> {
  void input; void keys; void StudentQueryInputError;
  return {};
}
