import { BLANK_OPTION, nonBlankCells, type ColumnSpec, type TextCell } from './cell';
import { compareCells } from './compare';

export interface ColumnOption { value: string; count: number }

/**
 * 選項面板（R2、R5）：範圍內所有不同的顯示文字＋「(空白)」（`~blank`，僅在有空白儲存格時），count 依 rowKey 去重；
 * 順序＝各 text 最小 cell 升冪，`~blank` 最後。
 */
export function buildColumnOptions<Row, Ctx>(
  rows: readonly Row[],
  spec: ColumnSpec<Row, Ctx>,
  ctx: Ctx,
  inScope: (row: Row) => boolean = () => true,
  rowKey: (row: Row, index: number) => string = (_row, index) => String(index),
): ColumnOption[] {
  const byText = new Map<string, { min: TextCell; keys: Set<string> }>();
  const blankKeys = new Set<string>();
  rows.forEach((row, index) => {
    if (!inScope(row)) return;
    const key = rowKey(row, index);
    const present = nonBlankCells(spec.cells(row, ctx));
    if (present.length === 0) { blankKeys.add(key); return; }
    for (const c of present) {
      const entry = byText.get(c.text);
      if (!entry) byText.set(c.text, { min: c, keys: new Set([key]) });
      else {
        entry.keys.add(key);
        if (compareCells(c, entry.min, 'asc') < 0) entry.min = c;
      }
    }
  });
  const options = [...byText.entries()]
    .sort(([, a], [, b]) => compareCells(a.min, b.min, 'asc'))
    .map(([text, entry]) => ({ value: text, count: entry.keys.size }));
  if (blankKeys.size) options.push({ value: BLANK_OPTION, count: blankKeys.size });
  return options;
}
