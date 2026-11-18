import type { ColumnSpec } from './cell';

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
  void rows; void spec; void ctx; void inScope; void rowKey;
  return [];
}
