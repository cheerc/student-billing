import type { CursorPosition, SortSpec } from '@/contracts/student-query';

/**
 * D65 B3：學生查詢共用排序 SQL。順序＝`(<col> IS NULL), <col> <dir>, person_code ASC`
 * （空值不論方向排最後、同值依 personCode 升冪）；分頁用同一順序的 keyset 比較。
 * 文字欄（name）採 SQLite 預設 BINARY collation（UTF-8 碼點序），非 zh-Hant（C1）。
 */
export interface SortSql {
  orderBy: string;
  /** keyset 分頁條件（無游標回 null） */
  keyset: (cursor: CursorPosition | null) => { sql: string; args: Array<string | number> } | null;
  /** 取下一頁游標所需的排序值（未排序為 undefined） */
  valueOf: (row: Record<string, any>) => string | number | null | undefined;
}

export function buildSortSql(sort: SortSpec | undefined, columns: Record<string, string>, alias: string): SortSql {
  const person = `${alias}.person_code`;
  if (!sort) {
    return {
      orderBy: `${person} ASC`,
      keyset: (c) => (c ? { sql: `${person} > ?`, args: [c.personCode] } : null),
      valueOf: () => undefined,
    };
  }
  const column = columns[sort.field];
  const col = `${alias}.${column}`;
  const cmp = sort.dir === 'asc' ? '>' : '<';
  return {
    orderBy: `(${col} IS NULL) ASC, ${col} ${sort.dir === 'asc' ? 'ASC' : 'DESC'}, ${person} ASC`,
    keyset: (c) => {
      if (!c) return null;
      if (c.sortValue === undefined) throw new Error('cursor 缺少排序值');
      if (c.sortValue === null) return { sql: `(${col} IS NULL AND ${person} > ?)`, args: [c.personCode] };
      return { sql: `(${col} IS NULL OR ${col} ${cmp} ? OR (${col} = ? AND ${person} > ?))`, args: [c.sortValue, c.sortValue, c.personCode] };
    },
    valueOf: (row) => row[column] ?? null,
  };
}
