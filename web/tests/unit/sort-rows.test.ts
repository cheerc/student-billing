import { describe, it, expect } from 'vitest';
import { nextSort, sortRows } from '@/components/tables/use-client-sort';

/**
 * UX126（D65 G5）：client 表排序純函式。
 * expected 依規格手算（空值最後、同值保持輸入相對順序、文字用 zh-Hant collator），
 * 不以 sortRows 自身輸出生成。
 */
type Row = { id: string; v: number | string | null };
const num = { type: 'number' as const, accessor: (r: Row) => r.v as number | null };
const text = { type: 'text' as const, accessor: (r: Row) => r.v as string | null };
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

  it('中文文字：比較依據為 Intl.Collator("zh-Hant")（in-test 以 collator 逐對驗證，非 sortRows 輸出）', () => {
    const collator = new Intl.Collator('zh-Hant');
    const names = ['王小明', '李大華', '陳美玲', '張志強', '林雅婷', null, '黃建國'];
    const asc = values(sortRows(rows(names), text, 'ascending'));
    // 空值在最後；其餘每一對相鄰值 collator.compare ≤ 0
    expect(asc[asc.length - 1]).toBeNull();
    const nonNull = asc.slice(0, -1) as string[];
    expect(nonNull).toHaveLength(6);
    for (let i = 1; i < nonNull.length; i++) {
      expect(collator.compare(nonNull[i - 1]!, nonNull[i]!)).toBeLessThanOrEqual(0);
    }
    const desc = values(sortRows(rows(names), text, 'descending'));
    expect(desc[desc.length - 1]).toBeNull();
    const nonNullDesc = desc.slice(0, -1) as string[];
    for (let i = 1; i < nonNullDesc.length; i++) {
      expect(collator.compare(nonNullDesc[i - 1]!, nonNullDesc[i]!)).toBeGreaterThanOrEqual(0);
    }
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
