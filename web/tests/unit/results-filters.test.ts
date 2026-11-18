import { describe, it, expect } from 'vitest';
import * as filters from '@/lib/results-filters';
import {
  buildResultsQuery, buildStudentApiParams, chipsOf, exactlyOneClass, pruneStudentFilters, readResultsUrl,
  scopeOf, STUDENT_FILTER_FIELDS, type StudentFilters,
} from '@/lib/results-filters';
import { parseResultsState, pruneResultsState } from '@/lib/results-state';

/** 已選0人仍是合法run值；只隱藏未選0人，不把facet count當作prune domain。 */
describe('Excel 式面板零人值', () => {
  it('prune 保留已選0人值與 ~none（既有保護性 GREEN）', () => {
    const selected: StudentFilters = { grade: ['3'], sibling: ['~none'] };
    const options = { grade: [{ value: '3', count: 0 }] };
    expect(filters.pruneStudentFilters(selected, options)).toEqual({ filters: selected, removed: [] });
  });
  it('面板隱藏未選0人、保留已選0人與沒有count的舊選項', () => {
    // 新helper由真panel使用；namespace cast讓RED在runtime而非typecheck import階段失敗。
    const visible = (filters as unknown as { visibleFilterOptions: <T extends { value: string; count?: number }>(options: T[], selected: string[]) => T[] }).visibleFilterOptions;
    const options = [{ value: '1', count: 2 }, { value: '2', count: 0 }, { value: '3', count: 0 }, { value: 'legacy' }];
    expect(visible(options, ['3'])).toEqual([options[0], options[2], options[3]]);
    expect(visible(options, ['~none'])).toEqual([options[0], options[3]]);
  });
});

/**
 * D66 P4（03 §5.1 R7、09 §5.1「網址」）：學生總表條件一律為 `col.<columnKey>=<顯示文字>`。
 * 以下 expected 皆由 03／09 手算：columnKey 見 03 R6；舊語意參數載入時一律移除並提示。
 */
describe('學生總表網址 col.*（D66 P4）', () => {
  const read = (qs: string) => readResultsUrl(new URLSearchParams(qs));

  it('readResultsUrl：col.<key> 重複 key 讀成顯示文字多值，~blank 原樣、sort／view／runId 不變', () => {
    const state = read('view=students&runId=r1&sort=-name&col.grade=1年級&col.grade=小班&col.enrollment=~blank&col.baseDiscount=95折&dClass=班A');
    expect(state.filters).toEqual({ grade: ['1年級', '小班'], enrollment: ['~blank'], baseDiscount: ['95折'] });
    expect(state.sort).toBe('-name');
    expect(state.runId).toBe('r1');
    expect(state.deductionFilters).toEqual({ dClass: ['班A'] });
  });

  it('readResultsUrl：「天數不同」「待核對」是 review 欄的一般顯示文字', () => {
    expect(read('col.review=天數不同&col.review=待核對').filters).toEqual({ review: ['天數不同', '待核對'] });
  });

  it('buildResultsQuery：寫出 col.<key>，且不再寫任何舊語意參數', () => {
    const query = buildResultsQuery({
      view: 'students', runId: 'r1', sort: null,
      filters: { grade: ['1年級'], review: ['天數不同', '待核對'], enrollment: ['~~x'] },
      deductionFilters: { dClass: ['班A'] }, legacy: [], invalidColumns: {},
    });
    const params = new URLSearchParams(query);
    expect(params.getAll('col.grade')).toEqual(['1年級']);
    expect(params.getAll('col.review')).toEqual(['天數不同', '待核對']);
    expect(params.getAll('col.enrollment')).toEqual(['~~x']);
    expect(params.getAll('dClass')).toEqual(['班A']);
    for (const legacy of ['grade', 'enrollmentKey', 'issueCode', 'tierMismatch']) expect(params.has(legacy)).toBe(false);
  });

  it('buildStudentApiParams：條件走 col.<key>，q 只放 API 參數，extra 保留', () => {
    const params = buildStudentApiParams({ grade: ['1年級'], enrollment: ['班A', '~blank'] }, ' 王 ', { limit: '50', options: 'true' });
    expect(params.getAll('col.grade')).toEqual(['1年級']);
    expect(params.getAll('col.enrollment')).toEqual(['班A', '~blank']);
    expect(params.get('q')).toBe('王');
    expect(params.get('limit')).toBe('50');
    expect(params.has('grade')).toBe(false);
    expect(params.has('enrollmentKey')).toBe(false);
  });

  it('舊語意參數不論值是否有效一律移除並提示（依固定欄序），col.* 照常生效', () => {
    const state = parseResultsState(new URLSearchParams('grade=3&enrollmentKey=班A&hasExtraDeduction=maybe&issueCode=CLASS_NOT_MAPPED&col.sibling=有'));
    expect(state.invalid).toBe(false);
    expect(state.filters).toEqual({ sibling: ['有'] });
    expect(state.pruned).toEqual([
      { column: '所屬班級', label: '班A' },
      { column: '年級', label: '3' },
      { column: '額外扣天', label: 'maybe' },
      { column: '需確認', label: 'CLASS_NOT_MAPPED' },
    ]);
  });

  it('只有舊語意參數：filters 為空且帶提示，不判無效', () => {
    const state = parseResultsState(new URLSearchParams('tierMismatch=true&anqinDays=4'));
    expect(state.filters).toEqual({});
    expect(state.invalid).toBe(false);
    expect(state.pruned.map((p) => p.column)).toEqual(['安親天數', '需確認']);
  });

  it.each([
    ['未知 columnKey', 'col.bogus=x&col.grade=1年級'],
    ['不可篩選欄 name', 'col.name=王一'],
    ['不可篩選欄 subjectCount', 'col.subjectCount=2'],
    ['空字串值', 'col.grade=&col.sibling=有'],
    ['未跳脫的 ~ 開頭值', 'col.grade=~x'],
    ['~empty 已不是保留值', 'col.enrollment=~empty'],
    ['~none 與其他值並存', 'col.grade=~none&col.grade=1年級'],
  ])('網址條件無效（%s）：忽略全部條件並標 invalid', (_name, qs) => {
    const state = parseResultsState(new URLSearchParams(qs));
    expect(state.invalid).toBe(true);
    expect(state.filters).toEqual({});
  });

  it('~~ 跳脫與 ~blank／單獨 ~none 都是合法條件', () => {
    const state = parseResultsState(new URLSearchParams('col.enrollment=~~x&col.enrollment=~blank&col.grade=~none'));
    expect(state.invalid).toBe(false);
    expect(state.filters).toEqual({ enrollment: ['~~x', '~blank'], grade: ['~none'] });
  });

  it('本班適用折扣：恰選一班才保留；其他情形移除並提示', () => {
    expect(parseResultsState(new URLSearchParams('col.enrollment=班A&col.applicableDiscount=9折')).filters)
      .toEqual({ enrollment: ['班A'], applicableDiscount: ['9折'] });
    for (const qs of [
      'col.enrollment=班A&col.enrollment=班B&col.applicableDiscount=9折',
      'col.enrollment=~blank&col.applicableDiscount=9折',
      'col.enrollment=班名無法解析&col.applicableDiscount=9折',
      'col.applicableDiscount=9折',
    ]) {
      const state = parseResultsState(new URLSearchParams(qs));
      expect(state.invalid).toBe(false);
      expect(state.filters.applicableDiscount).toBeUndefined();
      expect(state.pruned).toEqual([{ column: '本班適用折扣', label: '9折' }]);
    }
  });

  it('exactlyOneClass 讀 col.enrollment：排除 ~blank／~none／班名無法解析／多選，跳脫還原', () => {
    expect(exactlyOneClass({ enrollment: ['班A'] })).toBe('班A');
    expect(exactlyOneClass({ enrollment: ['~~班'] })).toBe('~班');
    expect(exactlyOneClass({ enrollment: ['~blank'] })).toBeNull();
    expect(exactlyOneClass({ enrollment: ['~none'] })).toBeNull();
    expect(exactlyOneClass({ enrollment: ['班名無法解析'] })).toBeNull();
    expect(exactlyOneClass({ enrollment: ['班A', '班B'] })).toBeNull();
    expect(exactlyOneClass({})).toBeNull();
  });

  it('scopeOf：(空白)／班名無法解析為單一保留項目，其餘依選班數', () => {
    expect(scopeOf({})).toEqual({ kind: 'all', count: 0 });
    expect(scopeOf({ enrollment: ['班A'] })).toEqual({ kind: 'single', count: 1 });
    expect(scopeOf({ enrollment: ['班A', '班B'] })).toEqual({ kind: 'multi', count: 2 });
    expect(scopeOf({ enrollment: ['~blank'] })).toEqual({ kind: 'special', count: 1, special: '(空白)' });
    expect(scopeOf({ enrollment: ['班名無法解析'] })).toEqual({ kind: 'special', count: 1, special: '班名無法解析' });
    expect(scopeOf({ enrollment: ['~none'] })).toEqual({ kind: 'none', count: 0 });
  });

  it('pruneStudentFilters 依 columnOptions（顯示文字；~blank 原樣、字面 ~ 以 ~~ 比對）剪枝', () => {
    const result = pruneStudentFilters(
      { grade: ['1年級', '9年級'], enrollment: ['班A', '~blank', '~~x'], review: ['~none'] },
      {
        grade: [{ value: '1年級', count: 1 }],
        enrollment: [{ value: '班A', count: 0 }, { value: '~blank', count: 0 }, { value: '~x', count: 1 }],
      }
    );
    expect(result.filters).toEqual({ grade: ['1年級'], enrollment: ['班A', '~blank', '~~x'], review: ['~none'] });
    expect(result.removed).toEqual([{ column: '年級', label: '9年級' }]);
  });

  it('pruneStudentFilters：不再恰選一班時整欄移除本班適用折扣', () => {
    const result = pruneStudentFilters({ applicableDiscount: ['9折'] }, { applicableDiscount: [{ value: '9折', count: 1 }] });
    expect(result.filters).toEqual({});
    expect(result.removed).toEqual([{ column: '本班適用折扣', label: '9折' }]);
  });

  it('pruneResultsState：deferApplicable 暫緩單班適用折扣，其餘照 columnOptions 剪枝', () => {
    const state = { ...parseResultsState(new URLSearchParams('col.enrollment=班A&col.applicableDiscount=9折&col.grade=9年級')) };
    const result = pruneResultsState(state, { enrollment: [{ value: '班A', count: 1 }], grade: [{ value: '1年級', count: 1 }] }, true);
    expect(result.filters).toEqual({ enrollment: ['班A'], applicableDiscount: ['9折'] });
    expect(result.pruned).toEqual([{ column: '年級', label: '9年級' }]);
  });

  it('chipsOf：欄名＋顯示文字（~blank→(空白)、~~x→~x、~none→已取消全選），依欄序', () => {
    const chips = chipsOf({ grade: ['~none'], enrollment: ['~blank', '班A', '~~x'] }, STUDENT_FILTER_FIELDS);
    expect(chips).toEqual([
      { key: 'enrollment', column: '所屬班級', label: '(空白)', remaining: ['班A', '~~x'] },
      { key: 'enrollment', column: '所屬班級', label: '班A', remaining: ['~blank', '~~x'] },
      { key: 'enrollment', column: '所屬班級', label: '~x', remaining: ['~blank', '班A'] },
      { key: 'grade', column: '年級', label: '已取消全選', remaining: [] },
    ]);
  });

  it('studentFiltersToParams：供 SSR 呼叫 server（col.<key> 重複值）', () => {
    const toParams = (filters as unknown as { studentFiltersToParams: (f: StudentFilters) => Record<string, string[]> }).studentFiltersToParams;
    expect(toParams({ grade: ['1年級'], enrollment: ['班A', '~blank'] })).toEqual({ 'col.grade': ['1年級'], 'col.enrollment': ['班A', '~blank'] });
  });
});

/**
 * P3a 審查帶入：`col.applicableDiscount` 存在時，server 的 columnOptions.enrollment 會以「已選班」的適用折扣範圍計數其他候選班。
 * UI 解法：班級選取任何改變（加／減／換）即同時清掉 applicableDiscount，面板不會在過期折扣條件下顯示跨班計數。
 */
describe('班級選取改變清除本班適用折扣（D66 P4）', () => {
  const reconcile = (prev: StudentFilters, next: StudentFilters) =>
    (filters as unknown as {
      reconcileStudentFilters: (p: StudentFilters, n: StudentFilters) => { filters: StudentFilters; removedApplicable: 'class-changed' | 'not-single' | null };
    }).reconcileStudentFilters(prev, next);
  const A9 = { enrollment: ['班A'], applicableDiscount: ['9折'] } satisfies StudentFilters;

  it('換班：班A→班B 清掉 applicableDiscount（chip 隨之消失）', () => {
    const r = reconcile(A9, { enrollment: ['班B'], applicableDiscount: ['9折'] });
    expect(r.filters).toEqual({ enrollment: ['班B'] });
    expect(r.removedApplicable).toBe('class-changed');
    expect(chipsOf(r.filters, STUDENT_FILTER_FIELDS).map((c) => c.key)).toEqual(['enrollment']);
  });

  it('加班（變多選）與取消班級都清掉，並以 not-single 標示不再恰選一班', () => {
    expect(reconcile(A9, { enrollment: ['班A', '班B'], applicableDiscount: ['9折'] })).toEqual({ filters: { enrollment: ['班A', '班B'] }, removedApplicable: 'not-single' });
    expect(reconcile(A9, { applicableDiscount: ['9折'] })).toEqual({ filters: {}, removedApplicable: 'not-single' });
  });

  it('班級不變時保留 applicableDiscount；其他欄改動、空陣列整欄移除', () => {
    expect(reconcile(A9, { ...A9, grade: ['1年級'], sibling: [] })).toEqual({ filters: { ...A9, grade: ['1年級'] }, removedApplicable: null });
  });

  it('本來沒有 applicableDiscount：換班不提示；新加 applicableDiscount 於同班保留', () => {
    expect(reconcile({ enrollment: ['班A'] }, { enrollment: ['班B'] })).toEqual({ filters: { enrollment: ['班B'] }, removedApplicable: null });
    expect(reconcile({ enrollment: ['班A'] }, A9)).toEqual({ filters: A9, removedApplicable: null });
  });
});
