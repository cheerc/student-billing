import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DetailDrawer from '@/components/detail-drawer';
import type { StudentCalculationItem } from '@/application/query-students';

/**
 * R4-S01（decision d-20261004023234726869-2）：學生明細的「折扣推導」區塊
 * 不得出現「null」字樣，且與學生總表同源。
 *
 * 裁定對照（預期字串由裁定推出，不由產品輸出回填，根 CLAUDE.md §8）：
 *   已補科數      subjectCount === null → 「無班級」（不含「(null)」）
 *   基本折扣率    整段重用 summary-table 的 formatBaseDiscount：
 *                 null → 「未設定」、10000 → 「無折扣」、9500 → 「95折」、9000 → 「9折」
 *
 * 舊顯示是工程式複合格式（null → 「無 (null)」、9500 → 「95% (9.5折)」、
 * 10000 → 「100% (10折)」），行政看不懂；「無折扣／95折／9折」是總表已在用的正式用語
 * （D42／operator 裁決），故明細與總表同源。
 */

const base = {
  id: 'c1', runId: 'run_1', personCode: 'STU_ZERO', name: '合成零報名生',
  branch: '合成分校', grade: null, gradeRaw: '',
  subjectCount: null, baseDiscountBps: null,
  anqinDays: null, anqinDisplay: null, tutoringDays: null, tutoringDisplay: null,
  englishDays: null, mathDays: null, chineseDays: null, homeworkDays: null,
  intensiveEnglishDays: null, saturdayTutoringDays: null,
  applicableAnqinBps: null, applicableTutoringBps: null,
  applicableEnglishBps: null, applicableMathBps: null,
  tierMismatch: false, tierComparisons: [], issues: [], hasIssues: false,
  trace: { rawTags: '' }, createdAt: '2026-10-04T00:00:00.000Z',
  enrollments: [], sourceRow: 2, classText: null,
};

/**
 * 只取「折扣推導」區塊（裁定範圍）。
 *
 * 整個抽屜不能拿來斷言不含 null／%：底部「技術資訊」摺疊區會 JSON.stringify 整筆
 * student，其中本來就有 `"subjectCount": null` 這類原始欄位——那是 D39 規定放在
 * 「詳細資訊」的原始資料，不是使用者可見的文案。
 */
function discountBlock(html: string): string {
  const start = html.indexOf('<h4 style="font-size:0.875rem;font-weight:700;margin-bottom:8px">折扣推導</h4>');
  expect(start, '找不到「折扣推導」區塊').toBeGreaterThan(-1);
  const end = html.indexOf('課程與扣天', start);
  return html.slice(start, end === -1 ? html.length : end);
}

const render = (over: Partial<StudentCalculationItem>) =>
  discountBlock(
    renderToStaticMarkup(
      React.createElement(DetailDrawer, {
        student: { ...base, ...over } as StudentCalculationItem,
        onClose: () => {},
      })
    )
  );

describe('R4-S01：學生明細的折扣推導區塊不含「null」且與學生總表同源', () => {
  it('零報名（subjectCount／baseDiscountBps 皆 null）：顯示「無班級」「未設定」，全篇無 null 字樣', () => {
    const html = render({});

    // 裁定指定的兩個字串。
    expect(html).toContain('無班級');
    expect(html).toContain('未設定');
    // 使用者可見處不得出現「null」字樣（含舊的「無班級 (null)」「無 (null)」）。
    expect(html).not.toContain('null');
  });

  it('基本折扣率整段走 formatBaseDiscount：非 null 值也用總表的正式短標', () => {
    // 預期依 formatDiscountBps 的定義（src/application/roster-changes.ts:184）：
    //   10000 → 「無折扣」、9500 → 「95折」、9000 → 「9折」
    // 舊顯示為「100% (10折)」「95% (9.5折)」的工程式複合格式。
    expect(render({ subjectCount: 2, baseDiscountBps: 10000 })).toContain('無折扣');
    expect(render({ subjectCount: 2, baseDiscountBps: 9500 })).toContain('95折');
    expect(render({ subjectCount: 2, baseDiscountBps: 9000 })).toContain('9折');

    // 舊的百分比複合格式不得殘留。
    for (const bps of [10000, 9500, 9000]) {
      const html = render({ subjectCount: 2, baseDiscountBps: bps });
      expect(html, `${bps} 仍顯示百分比複合格式`).not.toContain('%');
      expect(html, `${bps} 仍顯示 10折 這類工程式寫法`).not.toContain('(10折)');
    }
  });

  it('零報名但有基本率（D42：科數 null 時合計折扣預設 10000）顯示「無班級」「無折扣」', () => {
    const html = render({ subjectCount: null, baseDiscountBps: 10000 });
    expect(html).toContain('無班級');
    expect(html).toContain('無折扣');
    expect(html).not.toContain('null');
  });

  it('「已補科數」有值時仍顯示科數，不受 null 顯示調整影響', () => {
    const html = render({ subjectCount: 3, baseDiscountBps: 9000 });
    expect(html).toContain('3 科');
    expect(html).toContain('9折');
    expect(html).not.toContain('無班級');
  });
});

/**
 * issue #100：學生明細的「各課程適用率」改用與學生總表相同的格式化。
 *
 * 舊顯示是 `applicable*Bps ? `${bps / 100}%` : '-'`：有值時是工程式百分比
 * （9000 → 「90%」），與學生總表的正式短標（9折／無折扣／95折）不一致。
 *
 * 裁定對照（預期字串由 formatDiscountBps 的定義推出，不由產品輸出回填，根 CLAUDE.md §8）：
 *   null   → 「—」
 *   10000  → 「無折扣」
 *   9500   → 「95折」
 *   9000   → 「9折」
 *
 * null 採「—」而非「未設定」的理由見 src/components/detail-drawer.tsx 的 helper 註解：
 * 總表的兩種 null 語義需靠班別資訊區分，明細拿不到班別，故一律「—」。
 */
describe('issue #100：學生明細各課程適用率與學生總表同格式', () => {
  const COURSES = [
    { label: '安親', key: 'applicableAnqinBps' },
    { label: '課輔', key: 'applicableTutoringBps' },
    { label: '美語', key: 'applicableEnglishBps' },
    { label: '數學', key: 'applicableMathBps' },
  ] as const;

  /** 四個科目同時套用同一組 bps，讓每個科目都經過一次格式化。 */
  const renderAllSubjects = (bps: number | null) =>
    render({
      subjectCount: 2,
      baseDiscountBps: 9000,
      applicableAnqinBps: bps,
      applicableTutoringBps: bps,
      applicableEnglishBps: bps,
      applicableMathBps: bps,
    });

  it('null：四個科目都顯示「—」，不出現百分比，也不顯示「未設定」', () => {
    const html = renderAllSubjects(null);

    for (const { label } of COURSES) {
      expect(html, `${label} 應顯示「—」`).toContain(`${label}: —`);
    }
    // 明細拿不到班別，無法區分 not_configured，一律「—」（不得顯示「未設定」）。
    expect(html).not.toContain('未設定');
    // 舊的 '-' fallback 與百分比複合格式都不得殘留。
    for (const { label } of COURSES) {
      expect(html, `${label} 仍顯示舊的「-」`).not.toContain(`${label}: -`);
    }
    expect(html).not.toContain('%');
  });

  it('10000：四個科目都顯示「無折扣」', () => {
    const html = renderAllSubjects(10000);
    for (const { label } of COURSES) {
      expect(html, `${label} 應顯示「無折扣」`).toContain(`${label}: 無折扣`);
    }
    expect(html).not.toContain('100%');
  });

  it('9000：四個科目都顯示「9折」（不是「90%」）', () => {
    const html = renderAllSubjects(9000);
    for (const { label } of COURSES) {
      expect(html, `${label} 應顯示「9折」`).toContain(`${label}: 9折`);
    }
    expect(html).not.toContain('90%');
  });

  it('9500：四個科目都顯示「95折」（不是「95%」）', () => {
    const html = renderAllSubjects(9500);
    for (const { label } of COURSES) {
      expect(html, `${label} 應顯示「95折」`).toContain(`${label}: 95折`);
    }
    expect(html).not.toContain('95%');
  });

  it('各科目獨立取值：null 與有值並存時各自套用自己的格式', () => {
    const html = render({
      subjectCount: 2,
      baseDiscountBps: 9000,
      applicableAnqinBps: 10000,
      applicableTutoringBps: null,
      applicableEnglishBps: 9000,
      applicableMathBps: 9500,
    });

    expect(html).toContain('安親: 無折扣');
    expect(html).toContain('課輔: —');
    expect(html).toContain('美語: 9折');
    expect(html).toContain('數學: 95折');
  });
});