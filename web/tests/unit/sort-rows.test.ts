import { describe, it, expect } from 'vitest';
import { nextSort, sortRows } from '@/components/tables/use-client-sort';
import { cell } from '@/lib/table-columns/cell';

/**
 * UX126（D65 G5）＋UX133（D66）：client 表排序純函式，比較走共用 `compareCells`（欄位定義 `{ cell }`）。
 * expected 依規格手算（空白最後、同值保持輸入相對順序、中文依總筆畫數寫死），
 * 不以 sortRows、Intl.Collator 或其他待測函式的輸出生成。
 */
type Row = { id: string; v: number | string | null };
const toCell = (r: Row) => (r.v === null ? null : cell(r.v));
const num = { cell: toCell };
const text = { cell: toCell };
const rows = (vs: (number | string | null)[]): Row[] => vs.map((v, i) => ({ id: `r${i}`, v }));
const values = (rs: Row[]) => rs.map((r) => r.v);

describe('UX126 sortRows', () => {
  it('數值升冪：[3, null, 1, 2] → [1, 2, 3, null]', () => {
    expect(values(sortRows(rows([3, null, 1, 2]), num, 'ascending'))).toEqual([1, 2, 3, null]);
  });

  it('數值降冪：[3, null, 1, 2] → [3, 2, 1, null]（空值不論方向最後）', () => {
    expect(values(sortRows(rows([3, null, 1, 2]), num, 'descending'))).toEqual([3, 2, 1, null]);
  });

  it('數值依數值而非字串：[10, 9, 100] 升冪 → [9, 10, 100]', () => {
    expect(values(sortRows(rows([10, 9, 100]), num, 'ascending'))).toEqual([9, 10, 100]);
  });

  it("ASCII 文字升冪：['b', null, 'a'] → ['a', 'b', null]", () => {
    expect(values(sortRows(rows(['b', null, 'a']), text, 'ascending'))).toEqual(['a', 'b', null]);
  });

  it("ASCII 文字降冪：['b', null, 'a'] → ['b', 'a', null]", () => {
    expect(values(sortRows(rows(['b', null, 'a']), text, 'descending'))).toEqual(['b', 'a', null]);
  });

  it('兩列同值保持輸入相對順序（升冪與降冪都不反轉同值列）', () => {
    const input: Row[] = [
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
      { id: 'c', v: 0 },
    ];
    expect(sortRows(input, num, 'ascending').map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(sortRows(input, num, 'descending').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('空值之間也保持輸入相對順序', () => {
    const input: Row[] = [
      { id: 'x', v: null },
      { id: 'y', v: 2 },
      { id: 'z', v: null },
    ];
    expect(sortRows(input, num, 'ascending').map((r) => r.id)).toEqual(['y', 'x', 'z']);
    expect(sortRows(input, num, 'descending').map((r) => r.id)).toEqual(['y', 'x', 'z']);
  });

  it('中文文字依總筆畫數：丁2 王4 吳7 林8 黃12 蔡15（碼點序為 丁 吳 林 王 蔡 黃，兩者不同）', () => {
    const names = ['王一', '蔡一', '丁一', null, '黃一', '吳一', '林一'];
    expect(values(sortRows(rows(names), text, 'ascending'))).toEqual(['丁一', '王一', '吳一', '林一', '黃一', '蔡一', null]);
    expect(values(sortRows(rows(names), text, 'descending'))).toEqual(['蔡一', '黃一', '林一', '吳一', '王一', '丁一', null]);
  });

  it('同底層值再比顯示文字：4 與 4*額 兩格（value 同為 4）依 text 升冪、降冪反轉，空白仍最後', () => {
    const input = [
      { id: 'a', c: cell(4, '4*額') },
      { id: 'b', c: null },
      { id: 'c', c: cell(4, '4') },
      { id: 'd', c: cell(3.5, '3.5') },
    ];
    const by = { cell: (r: (typeof input)[number]) => r.c };
    expect(sortRows(input, by, 'ascending').map((r) => r.id)).toEqual(['d', 'c', 'a', 'b']);
    expect(sortRows(input, by, 'descending').map((r) => r.id)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('數值先於字串（混合欄）：[\'小班\', 3, null, 1] 升冪 → [1, 3, \'小班\', null]', () => {
    expect(values(sortRows(rows(['小班', 3, null, 1]), text, 'ascending'))).toEqual([1, 3, '小班', null]);
  });

  it('不改動輸入陣列', () => {
    const input = rows([3, 1, 2]);
    sortRows(input, num, 'ascending');
    expect(values(input)).toEqual([3, 1, 2]);
  });
});

describe('UX126 nextSort（兩態切換）', () => {
  it('未排序 → 點某欄 → 該欄升冪', () => {
    expect(nextSort(null, 'a')).toEqual({ key: 'a', dir: 'ascending' });
  });
  it('同欄再點：升冪 ↔ 降冪', () => {
    expect(nextSort({ key: 'a', dir: 'ascending' }, 'a')).toEqual({ key: 'a', dir: 'descending' });
    expect(nextSort({ key: 'a', dir: 'descending' }, 'a')).toEqual({ key: 'a', dir: 'ascending' });
  });
  it('點另一欄：從升冪開始', () => {
    expect(nextSort({ key: 'a', dir: 'descending' }, 'b')).toEqual({ key: 'b', dir: 'ascending' });
  });
});
