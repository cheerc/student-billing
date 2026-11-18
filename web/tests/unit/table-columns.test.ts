import { beforeAll, describe, expect, it } from 'vitest';
import { BLANK_OPTION, cell, matchesColumnSelection, nonBlankCells, type Cell, type ColumnSpec } from '@/lib/table-columns/cell';
import { compareCells, compareText, compareValues } from '@/lib/table-columns/compare';
import { buildColumnOptions } from '@/lib/table-columns/options';
import { encodeColumnFilterValue, isColumnParam, parseColumnFilters, type ColumnFilterKeys } from '@/contracts/column-filter';
import { StudentQueryInputError, decodeColumnCursor, encodeColumnCursor, encodeStudentCursor } from '@/contracts/student-query';

/**
 * UX129 (a)–(d)（共用欄位模組：值＋顯示文字、比較與選項序）與 UX131 (d) 的 cursor v3 單元部分。
 * expected 一律依 03 §5.1 D66 第 3–5、7、8 點與總筆畫數手算並寫死，不由 Intl.Collator 或待測函式產生（CLAUDE.md §8）。
 * 筆畫（總筆畫數相異）：丁2 王4 吳7 林8 黃12 蔡15；小3 國11。
 */
beforeAll(() => {
  // 結果取決於執行環境 ICU／CLDR 版本（03 §5.1 R4），記錄以便追查。
  console.log(`[table-columns] node=${process.version} icu=${process.versions.icu} cldr=${(process.versions as Record<string, string>).cldr}`);
});

const blank: Cell = null;
const sortCells = (cells: Cell[], dir: 'asc' | 'desc') => [...cells].sort((a, b) => compareCells(a, b, dir));
const values = (cells: Cell[]) => cells.map((c) => (c ? c.value : null));
const texts = (cells: Cell[]) => cells.map((c) => (c ? c.text : null));

describe('cell helpers', () => {
  it('cell() 預設 text 為 String(value)，可覆寫', () => {
    expect(cell(4)).toEqual({ value: 4, text: '4' });
    expect(cell('小班')).toEqual({ value: '小班', text: '小班' });
    expect(cell(4, '4*額')).toEqual({ value: 4, text: '4*額' });
  });

  it('nonBlankCells 去掉 null；空陣列與全 null 都是空白', () => {
    expect(nonBlankCells([])).toEqual([]);
    expect(nonBlankCells([null, null])).toEqual([]);
    expect(nonBlankCells([null, cell(3)])).toEqual([{ value: 3, text: '3' }]);
  });
});

describe('compareCells：UX129 (a) 混合值序', () => {
  const mixed: Cell[] = [cell('國一'), cell(3), blank, cell('7'), cell(1), cell('小班')];

  it('升冪：1, 3, "7", "小班", "國一", 空白（數值先於字串；數字字元先於漢字；小3 < 國11）', () => {
    expect(values(sortCells(mixed, 'asc'))).toEqual([1, 3, '7', '小班', '國一', null]);
  });

  it('降冪：反轉數值與文字，空白仍最後', () => {
    expect(values(sortCells(mixed, 'desc'))).toEqual(['國一', '小班', '7', 3, 1, null]);
  });

  it('空白不論方向皆最後；兩個空白相等', () => {
    expect(compareCells(blank, cell(1), 'asc')).toBeGreaterThan(0);
    expect(compareCells(blank, cell(1), 'desc')).toBeGreaterThan(0);
    expect(compareCells(cell(1), blank, 'asc')).toBeLessThan(0);
    expect(compareCells(cell(1), blank, 'desc')).toBeLessThan(0);
    expect(compareCells(blank, blank, 'asc')).toBe(0);
    expect(compareCells(blank, blank, 'desc')).toBe(0);
  });

  it('完全相同的 cell 比較為 0（personCode／輸入序由呼叫端決勝）', () => {
    expect(compareCells(cell(4, '4'), cell(4, '4'), 'asc')).toBe(0);
    expect(compareCells(cell('國一'), cell('國一'), 'desc')).toBe(0);
  });
});

describe('compareCells：UX129 (b) 姓名筆畫序（非碼點序）', () => {
  const names = ['蔡一', '黃一', '林一', '吳一', '王一', '丁一'].map((n) => cell(n));
  const codePointOrder = ['丁一', '吳一', '林一', '王一', '蔡一', '黃一'];

  it('升冪 丁一 王一 吳一 林一 黃一 蔡一（筆畫 2/4/7/8/12/15）', () => {
    const result = values(sortCells(names, 'asc'));
    expect(result).toEqual(['丁一', '王一', '吳一', '林一', '黃一', '蔡一']);
    expect(result).not.toEqual(codePointOrder);
  });

  it('降冪 蔡一 黃一 林一 吳一 王一 丁一', () => {
    expect(values(sortCells(names, 'desc'))).toEqual(['蔡一', '黃一', '林一', '吳一', '王一', '丁一']);
  });

  it('compareText／compareValues：數字字元先於漢字；數值先於字串', () => {
    expect(compareText('7', '小班')).toBeLessThan(0);
    expect(compareText('小班', '國一')).toBeLessThan(0);
    expect(compareText('國一', '小班')).toBeGreaterThan(0);
    expect(compareText('丁', '丁')).toBe(0);
    expect(compareValues(3, '7')).toBeLessThan(0);
    expect(compareValues('7', 3)).toBeGreaterThan(0);
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues(10, 2)).toBeGreaterThan(0);
    expect(compareValues(4, 4)).toBe(0);
  });

  it('collator 判為相等的字串以 UTF-16 碼元序決勝（e + U+0301 先於 é U+00E9）', () => {
    const decomposed = 'é';
    const composed = 'é';
    expect(compareText(decomposed, composed)).toBeLessThan(0);
    expect(compareText(composed, decomposed)).toBeGreaterThan(0);
  });
});

describe('compareCells：UX129 (c) 天數 4 與 4*額', () => {
  const days: Cell[] = [blank, cell(4, '4*額'), cell(3.5, '3.5'), cell(4, '4')];

  it('升冪 3.5 → 4（`4` 先於 `4*額`）→ 空白', () => {
    expect(texts(sortCells(days, 'asc'))).toEqual(['3.5', '4', '4*額', null]);
  });

  it('降冪 4*額 → 4 → 3.5 → 空白（降冪同時反轉 value 與 text 兩層）', () => {
    expect(texts(sortCells(days, 'desc'))).toEqual(['4*額', '4', '3.5', null]);
  });
});

describe('compareCells：UX129 (d) 折扣依 bps，不依字串', () => {
  const bps: Cell[] = [cell(10000, '無折扣'), cell(9000, '9折'), cell(9500, '95折')];

  it('升冪 9000, 9500, 10000；降冪 10000, 9500, 9000', () => {
    expect(values(sortCells(bps, 'asc'))).toEqual([9000, 9500, 10000]);
    expect(values(sortCells(bps, 'desc'))).toEqual([10000, 9500, 9000]);
    // 字串序（"95折" 先於 "9折"）與 bps 序不同，證明沒有改用顯示文字排序
    expect(texts(sortCells(bps, 'asc'))).toEqual(['9折', '95折', '無折扣']);
  });
});

type Row = { pc: string; cells: Cell[] };
const spec = (key: string): ColumnSpec<Row> => ({ key, label: key, filterable: true, sortable: true, cells: (row) => row.cells });
const keyOf = (row: Row) => row.pc;

describe('buildColumnOptions：選項順序、去重計數與「(空白)」最後', () => {
  it('UX129 (c)：A6 天數 → 3.5、4、4*額、4.5、~blank（`4` 與 `4*額` 兩項，count 以人數計）', () => {
    const rows: Row[] = [
      { pc: 'K1', cells: [cell(4, '4*額')] },
      { pc: 'K2', cells: [cell(4, '4')] },
      { pc: 'K3', cells: [cell(3.5, '3.5')] },
      { pc: 'K4', cells: [cell(4, '4*額')] },
      { pc: 'K5', cells: [] },
      { pc: 'K6', cells: [cell(4.5, '4.5')] },
    ];
    expect(buildColumnOptions(rows, spec('anqinDays'), undefined, () => true, keyOf)).toEqual([
      { value: '3.5', count: 1 },
      { value: '4', count: 1 },
      { value: '4*額', count: 2 },
      { value: '4.5', count: 1 },
      { value: BLANK_OPTION, count: 1 },
    ]);
  });

  it('年級混合值：1年級、3年級、7、小班、國一、~blank；空白即使在最前面的列也排最後', () => {
    const rows: Row[] = [
      { pc: 'P1', cells: [] },
      { pc: 'P2', cells: [cell('國一')] },
      { pc: 'P3', cells: [cell(3, '3年級')] },
      { pc: 'P4', cells: [cell('7')] },
      { pc: 'P5', cells: [cell(1, '1年級')] },
      { pc: 'P6', cells: [cell('小班')] },
    ];
    const result = buildColumnOptions(rows, spec('grade'), undefined, () => true, keyOf);
    expect(result.map((o) => o.value)).toEqual(['1年級', '3年級', '7', '小班', '國一', '~blank']);
  });

  it('折扣依 bps 排：9折、95折、無折扣（不依字串）', () => {
    const rows: Row[] = [
      { pc: 'A', cells: [cell(10000, '無折扣')] },
      { pc: 'B', cells: [cell(9000, '9折')] },
      { pc: 'C', cells: [cell(9500, '95折')] },
    ];
    expect(buildColumnOptions(rows, spec('baseDiscount'), undefined, () => true, keyOf).map((o) => o.value)).toEqual(['9折', '95折', '無折扣']);
  });

  it('多值欄：同一人同文字只計一次；零項目或全 null 都算空白；null 項目不產生選項', () => {
    const rows: Row[] = [
      { pc: 'S1', cells: [cell('班A'), cell('班A')] },
      { pc: 'S2', cells: [cell('班A'), cell('班B')] },
      { pc: 'S3', cells: [] },
      { pc: 'S4', cells: [blank] },
    ];
    expect(buildColumnOptions(rows, spec('enrollment'), undefined, () => true, keyOf)).toEqual([
      { value: '班A', count: 2 },
      { value: '班B', count: 1 },
      { value: '~blank', count: 2 },
    ]);
  });

  it('inScope 先限縮列：範圍外的列不產生選項也不計數', () => {
    const rows: Row[] = [
      { pc: 'S1', cells: [cell('班A')] },
      { pc: 'S2', cells: [cell('班B')] },
      { pc: 'S3', cells: [] },
    ];
    const result = buildColumnOptions(rows, spec('enrollment'), undefined, (row) => row.pc !== 'S2', keyOf);
    expect(result).toEqual([
      { value: '班A', count: 1 },
      { value: '~blank', count: 1 },
    ]);
  });

  it('範圍內沒有空白儲存格時不輸出 ~blank', () => {
    const rows: Row[] = [{ pc: 'S1', cells: [cell('班A')] }];
    expect(buildColumnOptions(rows, spec('enrollment'), undefined, () => true, keyOf)).toEqual([{ value: '班A', count: 1 }]);
  });

  it('同一顯示文字對應多個底層值時，以最小 cell 決定選項位置（X 的最小值 2 < Y 的 3）', () => {
    const rows: Row[] = [
      { pc: 'R1', cells: [cell(5, 'X')] },
      { pc: 'R2', cells: [cell(2, 'X')] },
      { pc: 'R3', cells: [cell(3, 'Y')] },
    ];
    expect(buildColumnOptions(rows, spec('x'), undefined, () => true, keyOf)).toEqual([
      { value: 'X', count: 2 },
      { value: 'Y', count: 1 },
    ]);
  });

  it('未提供 rowKey 時以列序為鍵（每列各計一次）', () => {
    const rows: Row[] = [{ pc: 'a', cells: [cell('甲')] }, { pc: 'a', cells: [cell('甲')] }];
    expect(buildColumnOptions(rows, spec('x'), undefined)).toEqual([{ value: '甲', count: 2 }]);
  });

  it('ctx 原樣傳給 cells()', () => {
    const withCtx: ColumnSpec<Row, { suffix: string }> = {
      key: 'c', label: 'c', filterable: true, sortable: false,
      cells: (row, ctx) => row.cells.map((c) => (c ? cell(c.value, `${c.text}${ctx.suffix}`) : c)),
    };
    const rows: Row[] = [{ pc: 'a', cells: [cell(1, 'x')] }];
    expect(buildColumnOptions(rows, withCtx, { suffix: '!' }, () => true, keyOf)).toEqual([{ value: 'x!', count: 1 }]);
  });
});

describe('matchesColumnSelection：篩選依顯示文字', () => {
  const sel = (texts: string[], flags: { blank?: boolean; none?: boolean } = {}) => ({ texts: new Set(texts), blank: flags.blank ?? false, none: flags.none ?? false });

  it('`4` 與 `4*額` 各自獨立：勾 `4*額` 不命中 `4`', () => {
    expect(matchesColumnSelection([cell(4, '4*額')], sel(['4*額']))).toBe(true);
    expect(matchesColumnSelection([cell(4, '4')], sel(['4*額']))).toBe(false);
  });

  it('多值欄任一項目命中即命中', () => {
    expect(matchesColumnSelection([cell('班A'), cell('班B')], sel(['班B']))).toBe(true);
    expect(matchesColumnSelection([cell('班A'), cell('班B')], sel(['班C']))).toBe(false);
  });

  it('blank 只命中真正空白（空陣列或全 null），不命中有值的列', () => {
    expect(matchesColumnSelection([], sel([], { blank: true }))).toBe(true);
    expect(matchesColumnSelection([null], sel([], { blank: true }))).toBe(true);
    expect(matchesColumnSelection([cell('小班')], sel([], { blank: true }))).toBe(false);
  });

  it('文字與 blank 並選為 OR；空白列不被純文字選擇命中', () => {
    expect(matchesColumnSelection([], sel(['小班'], { blank: true }))).toBe(true);
    expect(matchesColumnSelection([cell('小班')], sel(['小班'], { blank: true }))).toBe(true);
    expect(matchesColumnSelection([], sel(['小班']))).toBe(false);
  });

  it('none＝空集合，不命中任何列（含空白列）', () => {
    expect(matchesColumnSelection([cell('小班')], sel([], { none: true }))).toBe(false);
    expect(matchesColumnSelection([], sel([], { none: true }))).toBe(false);
  });
});

describe('col.* 解析（03 §5.1 R7）', () => {
  const keys: ColumnFilterKeys = {
    known: new Set(['name', 'grade', 'enrollment', 'anqinDays', 'subjectCount']),
    filterable: new Set(['grade', 'enrollment', 'anqinDays']),
  };
  const expect400 = (input: Record<string, unknown>, param: string) => {
    let error: unknown;
    try { parseColumnFilters(input, keys); } catch (e) { error = e; }
    expect(error, `${JSON.stringify(input)} 應回 400`).toBeInstanceOf(StudentQueryInputError);
    expect((error as StudentQueryInputError).statusCode).toBe(400);
    expect((error as StudentQueryInputError).message).toContain(`「${param}」`);
  };

  it('isColumnParam 只認 `col.` 前綴', () => {
    expect(isColumnParam('col.grade')).toBe(true);
    expect(isColumnParam('grade')).toBe(false);
    expect(isColumnParam('column')).toBe(false);
  });

  it('多值 OR、跨欄各自一組；非 col.* 參數不處理', () => {
    const result = parseColumnFilters({ 'col.grade': ['1年級', '小班'], 'col.anqinDays': '4*額', grade: ['3'], q: 'x' }, keys);
    expect(Object.keys(result).sort()).toEqual(['anqinDays', 'grade']);
    expect(result.grade).toEqual({ texts: new Set(['1年級', '小班']), blank: false, none: false });
    expect(result.anqinDays).toEqual({ texts: new Set(['4*額']), blank: false, none: false });
  });

  it('重複值去重；undefined／null／空陣列略過', () => {
    const result = parseColumnFilters({ 'col.grade': ['小班', '小班'], 'col.enrollment': undefined, 'col.anqinDays': [] }, keys);
    expect(result).toEqual({ grade: { texts: new Set(['小班']), blank: false, none: false } });
  });

  it('~blank 為保留值，可與文字並選', () => {
    const result = parseColumnFilters({ 'col.grade': ['~blank', '小班'] }, keys);
    expect(result.grade).toEqual({ texts: new Set(['小班']), blank: true, none: false });
  });

  it('~none 單獨出現＝空集合', () => {
    expect(parseColumnFilters({ 'col.grade': ['~none'] }, keys).grade).toEqual({ texts: new Set(), blank: false, none: true });
  });

  it('`~~` 跳脫：字面以 ~ 開頭的顯示文字（含恰為 ~blank、~none、~empty 的文字）', () => {
    expect(parseColumnFilters({ 'col.grade': ['~~x'] }, keys).grade.texts).toEqual(new Set(['~x']));
    expect(parseColumnFilters({ 'col.grade': ['~~'] }, keys).grade.texts).toEqual(new Set(['~']));
    const literal = parseColumnFilters({ 'col.grade': ['~~blank', '~~none', '~~empty'] }, keys).grade;
    expect(literal).toEqual({ texts: new Set(['~blank', '~none', '~empty']), blank: false, none: false });
  });

  it('encodeColumnFilterValue 前置 ~ 跳脫，與解析互為反運算', () => {
    expect(encodeColumnFilterValue('國一')).toBe('國一');
    expect(encodeColumnFilterValue('~x')).toBe('~~x');
    expect(encodeColumnFilterValue('~blank')).toBe('~~blank');
    expect(encodeColumnFilterValue('~~')).toBe('~~~');
    for (const text of ['國一', '~x', '~blank', '~none', '~~', '~']) {
      expect(parseColumnFilters({ 'col.grade': [encodeColumnFilterValue(text)] }, keys).grade).toEqual({ texts: new Set([text]), blank: false, none: false });
    }
  });

  it('400：未知 columnKey', () => {
    expect400({ 'col.bogus': ['1'] }, 'col.bogus');
    expect400({ 'col.': ['1'] }, 'col.');
  });

  it('400：不可篩選欄（name、subjectCount）', () => {
    expect400({ 'col.name': ['丁一'] }, 'col.name');
    expect400({ 'col.subjectCount': ['2'] }, 'col.subjectCount');
  });

  it('400：值為空字串', () => {
    expect400({ 'col.grade': [''] }, 'col.grade');
    expect400({ 'col.grade': ['小班', ''] }, 'col.grade');
  });

  it('400：以 ~ 開頭而非 ~~ 跳脫、亦非 ~blank／~none（含 ~empty）', () => {
    expect400({ 'col.grade': ['~x'] }, 'col.grade');
    expect400({ 'col.enrollment': ['~empty'] }, 'col.enrollment');
    expect400({ 'col.grade': ['~'] }, 'col.grade');
  });

  it('400：~none 與其他值並存（含 ~blank、另一個 ~none）', () => {
    expect400({ 'col.grade': ['~none', '小班'] }, 'col.grade');
    expect400({ 'col.grade': ['小班', '~none'] }, 'col.grade');
    expect400({ 'col.grade': ['~none', '~blank'] }, 'col.grade');
    expect400({ 'col.grade': ['~none', '~none'] }, 'col.grade');
  });

  it('不在值域的顯示文字不回 400（匹配 0 人由呼叫端處理）', () => {
    expect(parseColumnFilters({ 'col.grade': ['不存在'] }, keys).grade.texts).toEqual(new Set(['不存在']));
  });
});

describe('cursor v3 編碼與解碼（03 §5.1 R8；UX131 (d) 單元部分）', () => {
  const id = 'identity-abc';
  const raw = (body: Record<string, unknown>) => Buffer.from(JSON.stringify(body)).toString('base64');
  const body = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  const expectCursor400 = (cursor: string, sorted = true) => {
    let error: unknown;
    try { decodeColumnCursor(cursor, id, sorted); } catch (e) { error = e; }
    expect(error, cursor).toBeInstanceOf(StudentQueryInputError);
    expect((error as StudentQueryInputError).statusCode).toBe(400);
    expect((error as StudentQueryInputError).message).toContain('「cursor」');
  };

  it('線上形狀：非空白 { version:3, identity, p, v, t }；數值與字串以 JSON 型別區分', () => {
    expect(body(encodeColumnCursor(id, { personCode: 'K1', cell: { value: 4, text: '4*額' } }))).toEqual({ version: 3, identity: id, p: 'K1', v: 4, t: '4*額' });
    expect(body(encodeColumnCursor(id, { personCode: 'P5', cell: { value: '7', text: '7' } }))).toEqual({ version: 3, identity: id, p: 'P5', v: '7', t: '7' });
  });

  it('線上形狀：空白 { version:3, identity, p, n:true }（不帶 v、t）；未排序只有 p', () => {
    expect(body(encodeColumnCursor(id, { personCode: 'P11', cell: null }))).toEqual({ version: 3, identity: id, p: 'P11', n: true });
    expect(body(encodeColumnCursor(id, { personCode: 'P01' }))).toEqual({ version: 3, identity: id, p: 'P01' });
  });

  it('往返：與任何實值（含 0、空字串 text）皆可區分', () => {
    const positions = [
      { personCode: 'K1', cell: { value: 4, text: '4*額' } },
      { personCode: 'K2', cell: { value: 0, text: '0' } },
      { personCode: 'K3', cell: { value: '', text: '' } },
      { personCode: 'K4', cell: { value: '國一', text: '國一' } },
      { personCode: 'K5', cell: null },
    ];
    for (const position of positions) expect(decodeColumnCursor(encodeColumnCursor(id, position), id, true)).toEqual(position);
    expect(decodeColumnCursor(encodeColumnCursor(id, { personCode: 'K6' }), id, false)).toEqual({ personCode: 'K6' });
  });

  it('沒有 cursor 回 null', () => {
    expect(decodeColumnCursor(undefined, id)).toBeNull();
    expect(decodeColumnCursor('', id)).toBeNull();
  });

  it('400 指名 cursor：D65 v2 cursor、換 identity（換 sort／條件）', () => {
    expectCursor400(encodeStudentCursor(id, { personCode: 'P1', sortValue: 3 }));
    expectCursor400(encodeStudentCursor(id, { personCode: 'P1' }), false);
    expectCursor400(encodeColumnCursor('other-identity', { personCode: 'P1', cell: { value: 1, text: '1' } }));
  });

  it('400 指名 cursor：v 型別錯（true、null、物件、陣列）', () => {
    for (const v of [true, false, null, {}, []]) expectCursor400(raw({ version: 3, identity: id, p: 'P1', v, t: 'x' }));
  });

  it('400 指名 cursor：缺 t、缺 v、t 型別錯、t 或 v 字串超過 200', () => {
    expectCursor400(raw({ version: 3, identity: id, p: 'P1', v: 4 }));
    expectCursor400(raw({ version: 3, identity: id, p: 'P1', t: '4' }));
    expectCursor400(raw({ version: 3, identity: id, p: 'P1', v: 4, t: 4 }));
    expectCursor400(raw({ version: 3, identity: id, p: 'P1', v: 4, t: 'x'.repeat(201) }));
    expectCursor400(raw({ version: 3, identity: id, p: 'P1', v: 'x'.repeat(201), t: 'x' }));
  });

  it('400 指名 cursor：n 與 v 並存、n 非 true、n 帶 t', () => {
    expectCursor400(raw({ version: 3, identity: id, p: 'P1', n: true, v: 4 }));
    expectCursor400(raw({ version: 3, identity: id, p: 'P1', n: true, v: 4, t: '4' }));
    expectCursor400(raw({ version: 3, identity: id, p: 'P1', n: true, t: '4' }));
    expectCursor400(raw({ version: 3, identity: id, p: 'P1', n: false }));
    expectCursor400(raw({ version: 3, identity: id, p: 'P1', n: 'true' }));
  });

  it('400 指名 cursor：p 缺漏、空字串、非字串、超過 200；version 不是 3；未知欄位', () => {
    expectCursor400(raw({ version: 3, identity: id, n: true }));
    expectCursor400(raw({ version: 3, identity: id, p: '', n: true }));
    expectCursor400(raw({ version: 3, identity: id, p: 7, n: true }));
    expectCursor400(raw({ version: 3, identity: id, p: 'x'.repeat(201), n: true }));
    expectCursor400(raw({ version: 4, identity: id, p: 'P1', n: true }));
    expectCursor400(raw({ identity: id, p: 'P1', n: true }));
    expectCursor400(raw({ version: 3, identity: id, p: 'P1', n: true, extra: 1 }));
  });

  it('400 指名 cursor：形狀與本次是否排序不符', () => {
    expectCursor400(raw({ version: 3, identity: id, p: 'P1' }), true);
    expectCursor400(raw({ version: 3, identity: id, p: 'P1', n: true }), false);
    expectCursor400(raw({ version: 3, identity: id, p: 'P1', v: 4, t: '4' }), false);
  });

  it('400 指名 cursor：非 base64、非 JSON、過長、base64 不是規範編碼', () => {
    expectCursor400('not base64!!');
    expectCursor400(Buffer.from('not json').toString('base64'));
    expectCursor400('A'.repeat(4097));
    expectCursor400(Buffer.from(JSON.stringify({ version: 3, identity: id, p: 'P1', n: true })).toString('base64').replace(/=+$/, ''));
  });
});
