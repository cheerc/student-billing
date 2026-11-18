'use client';

import { useState } from 'react';
import type { ColumnDef } from './column-def';
import type { Cell } from '@/lib/table-columns/cell';
import { compareCells } from '@/lib/table-columns/compare';
import type { HeaderSortState } from './table-header-cell';

/**
 * client 全量資料表排序（specs/19 §3 B2、D65 G5、D66、04 UX126／UX133）。
 * 兩態（升冪↔降冪）；點另一欄從升冪開始；未點任何欄＝呼叫端原有預設順序。
 * 比較走共用 `compareCells`（`@/lib/table-columns/compare`）：數值先於字串、文字依 zh-Hant 筆畫序、
 * 空白（`null` cell）不論方向排最後；同值（含空白之間）保持輸入相對順序（穩定、不反轉）。
 * 排序狀態只存元件 state，不入網址。
 * （學生總表的 server 排序是另一條路，但比較規則同源，見 03 §5.1。）
 */
export type SortDirection = 'ascending' | 'descending';
export interface SortState {
  key: string;
  dir: SortDirection;
}
export interface ClientSort<Row> {
  cell: (row: Row) => Cell;
}

/** 點表頭後的下一個排序狀態。 */
export function nextSort(current: SortState | null, key: string): SortState {
  if (current && current.key === key) {
    return { key, dir: current.dir === 'ascending' ? 'descending' : 'ascending' };
  }
  return { key, dir: 'ascending' };
}

/** 純函式：回傳新陣列，不改動輸入。同值（compareCells 為 0）保持輸入序。 */
export function sortRows<Row>(rows: readonly Row[], sort: ClientSort<Row>, dir: SortDirection): Row[] {
  const direction = dir === 'ascending' ? 'asc' : 'desc';
  const decorated = rows.map((row, index) => ({ row, index, cell: sort.cell(row) }));
  decorated.sort((a, b) => compareCells(a.cell, b.cell, direction) || a.index - b.index);
  return decorated.map((d) => d.row);
}

/** 以欄位定義驅動的 client 排序 hook。無 client 排序設定的欄（含 server 欄）不提供 sort slot。 */
export function useClientSort<Row>(columns: readonly ColumnDef<Row>[]) {
  const [state, setState] = useState<SortState | null>(null);

  const headerSort = (key: string): HeaderSortState | undefined => {
    const col = columns.find((c) => c.key === key);
    if (!col || !col.sort || !('cell' in col.sort)) return undefined;
    return {
      dir: state && state.key === key ? state.dir : 'none',
      onToggle: () => setState((cur) => nextSort(cur, key)),
    };
  };

  const apply = (rows: readonly Row[]): Row[] => {
    const col = state ? columns.find((c) => c.key === state.key) : undefined;
    if (!state || !col || !col.sort || !('cell' in col.sort)) return rows.slice();
    return sortRows(rows, col.sort, state.dir);
  };

  return { state, headerSort, apply };
}
