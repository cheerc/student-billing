// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import SummaryTable from '@/components/summary-table';
import type { StudentCalculationItem } from '@/application/query-students';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 所屬班級欄的原始 token（年度前綴、`[N]` 修飾；D66 Q2-b）：
 * - 滑鼠：hover 班名時以單一表格層級 tooltip 呈現（role="tooltip"、不攔截點擊、Esc 可關）
 * - 不用 title（不可聚焦元素只靠 title＝hover-only，a11y.spec.ts rule 6）
 * - 不增加每個報名一個 tab stop；tooltip 不在 <td> 內，不改變儲存格文字（UX129 (e)）
 * 預期字串由規格（原始 token 原樣）推出，不由產品輸出回填。
 */
function stu(): StudentCalculationItem {
  const e = (rawToken: string, baseName: string) => ({
    rawToken, yearPrefix: null, baseName, groupFlag: null, modifiers: [], withdrawalDate: null,
    erpBillingTierRaw: null, erpBillingTier: null, tierParseStatus: 'not_applicable', parseStatus: 'ok',
  });
  return {
    id: 'r1', runId: 'run_1', personCode: 'STU_TIP', name: '合成生', branch: '本校', grade: 3, gradeRaw: '三年級',
    subjectCount: 1, baseDiscountBps: 10000, anqinDays: null, anqinDisplay: null, tutoringDays: null, tutoringDisplay: null,
    englishDays: null, mathDays: null, chineseDays: null, homeworkDays: null, intensiveEnglishDays: null, saturdayTutoringDays: null,
    applicableAnqinBps: null, applicableTutoringBps: null, applicableEnglishBps: null, applicableMathBps: null,
    tierMismatch: false, tierComparisons: [], issues: [], hasIssues: false, actionableIssues: [], actionableHasIssues: false,
    trace: {}, createdAt: '2026-11-18T00:00:00.000Z', sourceRow: 2, classText: null,
    enrollments: [e('2026兒童美語-KC[團]', '兒童美語-KC'), e('國小數學-三A', '國小數學-三A')],
  } as unknown as StudentCalculationItem;
}

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<SummaryTable students={[stu()]} onSelectStudent={() => {}} />);
  });
  return host;
}

const name0 = (h: HTMLElement) => h.querySelectorAll<HTMLElement>('.enroll-name')[0]!;
const hover = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null })); });
const leave = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });

describe('所屬班級原始 token tooltip（a11y rule 6 修正）', () => {
  it('無 title 屬性；原始 token 由 data-raw-token 提供；沒有 tooltip 時不渲染', async () => {
    const h = await mount();
    expect(h.querySelector('[title]')).toBeNull();
    expect(name0(h).getAttribute('data-raw-token')).toBe('2026兒童美語-KC[團]');
    expect(h.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('hover 班名顯示 role=tooltip（原始 token），離開即關；tooltip 不在 <td> 內、不攔截點擊', async () => {
    const h = await mount();
    const td = name0(h).closest('td')!;
    const textBefore = td.textContent;
    hover(name0(h));
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tip?.textContent).toBe('2026兒童美語-KC[團]');
    expect(td.contains(tip)).toBe(false);
    expect(td.textContent).toBe(textBefore);
    expect(tip!.style.pointerEvents).toBe('none');
    expect(tip!.style.position).toBe('fixed');
    leave(name0(h));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('Esc 關閉 tooltip；不增加 tab stop（enroll 欄內只有「另 N 班」按鈕可聚焦）', async () => {
    const h = await mount();
    hover(name0(h));
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(h.querySelectorAll('.enroll-cell a[href], .enroll-cell button, .enroll-cell [tabindex]').length).toBe(0);
  });
});
