/**
 * D66（03 §5.1 R1）：欄位定義對每列產生「底層值＋顯示文字」。純 TS、無 Node／SQLite 依賴，server 與 client 共用。
 */
export type CellValue = number | string;
export interface TextCell { value: CellValue; text: string }
/** `null`＝空白儲存格（顯示「—」；選項為 `~blank`）。 */
export type Cell = TextCell | null;
export type SortDir = 'asc' | 'desc';

export const BLANK_OPTION = '~blank';
export const BLANK_LABEL = '(空白)';
export const BLANK_CELL_TEXT = '—';

export interface ColumnSpec<Row, Ctx = undefined> {
  key: string;
  label: string;
  /** 單值欄回傳長度 0／1；多值欄回傳多個項目。空陣列或全為 null＝空白。 */
  cells(row: Row, ctx: Ctx): Cell[];
  filterable: boolean;
  sortable: boolean;
}

export interface ColumnSelectionLike { texts: ReadonlySet<string>; blank: boolean; none: boolean }

export function cell(value: CellValue, text: string = String(value)): TextCell {
  return { value, text };
}

/** 去掉 null 項目；回傳空陣列＝該列在此欄為空白。 */
export function nonBlankCells(cells: readonly Cell[]): TextCell[] {
  return cells.filter((c): c is TextCell => c !== null);
}

/** 篩選：依顯示文字；`none`＝空集合（不命中任何列）；`blank` 只命中真正空白。 */
export function matchesColumnSelection(cells: readonly Cell[], selection: ColumnSelectionLike): boolean {
  if (selection.none) return false;
  const present = nonBlankCells(cells);
  if (present.length === 0) return selection.blank;
  return present.some((c) => selection.texts.has(c.text));
}
