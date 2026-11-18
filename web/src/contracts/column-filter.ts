import { StudentQueryInputError, type StudentQueryInput } from './student-query';

export const COLUMN_PARAM_PREFIX = 'col.';
export interface ColumnSelection { texts: Set<string>; blank: boolean; none: boolean }
export interface ColumnFilterKeys { known: ReadonlySet<string>; filterable: ReadonlySet<string> }

export function isColumnParam(key: string): boolean {
  return key.startsWith(COLUMN_PARAM_PREFIX);
}

/** 顯示文字 → wire 值：字面以 `~` 開頭者前置 `~` 跳脫。 */
export function encodeColumnFilterValue(text: string): string {
  return text.startsWith('~') ? `~${text}` : text;
}

function invalid(param: string, reason: string): never {
  throw new StudentQueryInputError(`查詢參數「${param}」${reason}`);
}

function parseSelection(param: string, raw: string[]): ColumnSelection | undefined {
  if (raw.includes('~none')) {
    if (raw.length !== 1) invalid(param, '的 ~none 只能單獨出現');
    return { texts: new Set(), blank: false, none: true };
  }
  const texts = new Set<string>();
  let blank = false;
  for (const wire of raw) {
    if (wire === '') invalid(param, '的值不可為空字串（空白儲存格請用 ~blank）');
    if (wire === '~blank') { blank = true; continue; }
    if (wire.startsWith('~~')) { texts.add(wire.slice(1)); continue; }
    if (wire.startsWith('~')) invalid(param, '有未知保留值（字面以 ~ 開頭的值請前置 ~ 跳脫）');
    texts.add(wire);
  }
  return { texts, blank, none: false };
}

/** 解析輸入中所有 `col.<columnKey>` 參數；R7 的 400 一律丟 StudentQueryInputError 並指名該參數。 */
export function parseColumnFilters(input: StudentQueryInput, keys: ColumnFilterKeys): Record<string, ColumnSelection> {
  const result: Record<string, ColumnSelection> = {};
  for (const param of Object.keys(input)) {
    if (!isColumnParam(param)) continue;
    const columnKey = param.slice(COLUMN_PARAM_PREFIX.length);
    if (!keys.known.has(columnKey)) invalid(param, '未知或不支援');
    if (!keys.filterable.has(columnKey)) invalid(param, '的欄位不提供篩選');
    const source = input[param];
    if (source === undefined || source === null) continue;
    const raw = (Array.isArray(source) ? source : [source]).map(String);
    if (raw.length === 0) continue;
    const selected = parseSelection(param, raw);
    if (selected) result[columnKey] = selected;
  }
  return result;
}
