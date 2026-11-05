'use client';

import { useState } from 'react';
import type { ColumnDef } from './column-def';
import type { HeaderSortState } from './table-header-cell';

/**
 * client 全量資料表排序（specs/19 §3 B2、D65 G5、04 UX126）。
 * 兩態（升冪↔降冪）；點另一欄從升冪開始；未點任何欄＝呼叫端原有預設順序。
 * 空值（null／undefined／NaN）不論方向排最後；同值（含空值之間）保持輸入相對順序（穩定、不反轉）。
 * 文字用 `Intl.Collator('zh-Hant')`，數值依數值。排序狀態只存元件 state，不入網址。
 * （學生總表的 server 排序是另一條路，文字為 SQLite 碼點序；見 D65 Collation 分歧。）
 */
export type SortDirection = 'ascending' | 'descending';
export interface SortState {
  key: string;
  dir: SortDirection;
}
export interface ClientSort<Row> {
  type: 'text' | 'number';
  accessor: (row: Row) => string | number | null | undefined;
}

const COLLATOR = new Intl.Collator('zh-Hant');

const isEmpty = (v: unknown): v is null | undefined => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

/** 點表頭後的下一個排序狀態。 */
export function nextSort(current: SortState | null, key: string): SortState {
  if (current && current.key === key) {
    return { key, dir: current.dir === 'ascending' ? 'descending' : 'ascending' };
  }
  return { key, dir: 'ascending' };
}

/** 純函式：回傳新陣列，不改動輸入。 */
export function sortRows<Row>(rows: readonly Row[], sort: ClientSort<Row>, dir: SortDirection): Row[] {
  const sign = dir === 'ascending' ? 1 : -1;
  const decorated = rows.map((row, index) => ({ row, index, value: sort.accessor(row) }));
  decorated.sort((a, b) => {
    const aEmpty = isEmpty(a.value);
    const bEmpty = isEmpty(b.value);
    if (aEmpty || bEmpty) {
      if (aEmpty && bEmpty) return a.index - b.index;
      return aEmpty ? 1 : -1; // 空值最後，與方向無關
    }
    const cmp =
      sort.type === 'number'
        ? Number(a.value) - Number(b.value)
        : COLLATOR.compare(String(a.value), String(b.value));
    return cmp !== 0 ? sign * cmp : a.index - b.index;
  });
  return decorated.map((d) => d.row);
}

/** 以欄位定義驅動的 client 排序 hook。無 client 排序設定的欄（含 server 欄）不提供 sort slot。 */
export function useClientSort<Row>(columns: readonly ColumnDef<Row>[]) {
  const [state, setState] = useState<SortState | null>(null);

  const headerSort = (key: string): HeaderSortState | undefined => {
    const col = columns.find((c) => c.key === key);
    if (!col || !col.sort || !('accessor' in col.sort)) return undefined;
    return {
      dir: state && state.key === key ? state.dir : 'none',
      onToggle: () => setState((cur) => nextSort(cur, key)),
    };
  };

  const apply = (rows: readonly Row[]): Row[] => {
    const col = state ? columns.find((c) => c.key === state.key) : undefined;
    if (!state || !col || !col.sort || !('accessor' in col.sort)) return rows.slice();
    return sortRows(rows, col.sort, state.dir);
  };

  return { state, headerSort, apply };
}
