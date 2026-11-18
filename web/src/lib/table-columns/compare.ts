import type { Cell, CellValue, SortDir } from './cell';

export const TEXT_COLLATOR = new Intl.Collator('zh-Hant', { usage: 'sort', sensitivity: 'variant', numeric: false });

export function compareText(a: string, b: string): number {
  void a; void b;
  return 0;
}

/** 升冪：數值（小→大）→ 字串（TEXT_COLLATOR）。 */
export function compareValues(a: CellValue, b: CellValue): number {
  void a; void b;
  return 0;
}

/** 完整比較鍵 `(value, text)`；降冪同時反轉兩層；空白（null）不論方向恆最後。personCode／輸入序由呼叫端決勝。 */
export function compareCells(a: Cell, b: Cell, dir: SortDir = 'asc'): number {
  void a; void b; void dir;
  return 0;
}
