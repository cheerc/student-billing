import type { Cell, CellValue, SortDir } from './cell';

export const TEXT_COLLATOR = new Intl.Collator('zh-Hant', { usage: 'sort', sensitivity: 'variant', numeric: false });

export function compareText(a: string, b: string): number {
  const result = TEXT_COLLATOR.compare(a, b);
  if (result !== 0) return result;
  // collator 判為相等（如標準等價字串）時，以 UTF-16 碼元序決勝，使順序確定。
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 升冪：數值（小→大）→ 字串（TEXT_COLLATOR）。 */
export function compareValues(a: CellValue, b: CellValue): number {
  if (typeof a === 'number') return typeof b === 'number' ? (a < b ? -1 : a > b ? 1 : 0) : -1;
  return typeof b === 'number' ? 1 : compareText(a, b);
}

/** 完整比較鍵 `(value, text)`；降冪同時反轉兩層；空白（null）不論方向恆最後。personCode／輸入序由呼叫端決勝。 */
export function compareCells(a: Cell, b: Cell, dir: SortDir = 'asc'): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const result = compareValues(a.value, b.value) || compareText(a.text, b.text);
  return dir === 'desc' ? (result === 0 ? 0 : -result) : result;
}
