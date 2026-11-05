import React from 'react';
import type { ColumnDef } from './column-def';

/** 排序狀態；未提供＝不輸出 aria-sort 與排序按鈕（B1 尚未啟用排序）。 */
export interface HeaderSortState {
  dir: 'ascending' | 'descending' | 'none';
  onToggle: () => void;
}

interface TableHeaderCellProps {
  column: Pick<ColumnDef, 'label' | 'className'>;
  /** 欄名後的附加內容（例如單位、說明 tooltip） */
  children?: React.ReactNode;
  /** 表頭篩選觸發鈕（HeaderFilter），由呼叫端提供 */
  filter?: React.ReactNode;
  sort?: HeaderSortState;
  className?: string;
}

/** 資料表 `<th>`：欄名＋（可選）排序鈕＋（可選）篩選觸發鈕。無 sort 時輸出與舊 `<th>` 相同。 */
export default function TableHeaderCell({ column, children, filter, sort, className }: TableHeaderCellProps) {
  const cls = className ?? column.className;
  return (
    <th className={cls} aria-sort={sort && sort.dir !== 'none' ? sort.dir : undefined}>
      {sort ? (
        <button type="button" className="th-sort" onClick={sort.onToggle}>
          {column.label}
        </button>
      ) : (
        column.label
      )}
      {children}
      {filter ?? null}
    </th>
  );
}
