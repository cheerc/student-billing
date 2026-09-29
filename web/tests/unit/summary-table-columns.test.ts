import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SummaryTable, { formatBaseDiscount, STUDENT_TABLE_COLUMNS } from '@/components/summary-table';
import { formatDiscountBps } from '@/application/roster-changes';
import type { StudentCalculationItem } from '@/application/query-students';

/**
 * 09 §5.1 學生總表預設欄位（12 欄）與 UX14（八欄 null／false／0／特殊率／不適用、型別不混）：
 * 預設欄位為 姓名（凍結）、年級、所屬班級、安親天數、課輔天數、額外扣天、合計折扣、
 * 已補科數、兄弟姊妹折扣、特殊折扣、園內生、需確認。
 * 人員代碼、美語／數學／中文天數、寫功課等既有欄**移到欄位選擇／明細，不刪功能**。
 */

function item(over: Partial<StudentCalculationItem> = {}): StudentCalculationItem {
  return {
    id: 'r1',
    runId: 'run_1',
    personCode: 'STU0001',
    name: '王小明',
    branch: '本校',
    grade: 3,
    gradeRaw: '三年級',
    subjectCount: 2,
    baseDiscountBps: 9500,
    anqinDays: null,
    anqinDisplay: null,
    tutoringDays: 5,
    tutoringDisplay: '5',
    englishDays: 1,
    mathDays: 0.5,
    chineseDays: null,
    homeworkDays: null,
    intensiveEnglishDays: null,
    saturdayTutoringDays: null,
    applicableAnqinBps: 9500,
    applicableTutoringBps: 9500,
    applicableEnglishBps: 9500,
    applicableMathBps: 9500,
    tierMismatch: false,
    tierComparisons: [],
    issues: [],
    hasIssues: false,
    trace: {},
    createdAt: '2026-09-29T10:00:00.000Z',
    enrollments: [
      {
        rawToken: '國小數學-三A[團]',
        yearPrefix: null,
        baseName: '國小數學-三A',
        groupFlag: '團',
        modifiers: [],
        withdrawalDate: null,
        erpBillingTierRaw: '4.5',
        erpBillingTier: 4.5,
        tierParseStatus: 'parsed',
        parseStatus: 'ok',
      },
    ],
    classText: '國小數學-三A[團]',
    sourceRow: 2,
    ...over,
  } as StudentCalculationItem;
}

const render = (students: StudentCalculationItem[], props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    React.createElement(SummaryTable, { students, onSelectStudent: () => {}, ...props })
  );

describe('09 §5.1：學生總表預設欄位為 12 欄，既有欄位移不刪功能', () => {
  it('預設欄位順序為規格所列 12 欄（姓名／年級／所屬班級／安親／課輔／額外扣天／合計折扣／已補科數／兄弟姊妹／特殊折扣／園內生／需確認）', () => {
    expect(STUDENT_TABLE_COLUMNS).toEqual([
      '姓名',
      '年級',
      '所屬班級',
      '安親天數',
      '課輔天數',
      '額外扣天',
      '合計折扣',
      '已補科數',
      '兄弟姊妹折扣',
      '特殊折扣',
      '園內生',
      '需確認',
    ]);
  });

  it('表格標頭只呈現 12 個預設欄位；人員代碼與美語／數學／中文／寫功課不在預設欄（但功能未刪，於欄位選擇與明細）', () => {
    const html = render([item()]);
    const ths = html.match(/<th[^>]*>([\s\S]*?)<\/th>/g) ?? [];
    // ⓘ 為 tooltip 指示器（非欄位名稱的一部分），比對時去除
    const labels = ths
      .map((t) => t.replace(/<[^>]*>/g, '').replace(/\s*ⓘ/g, '').trim())
      .filter(Boolean);
    expect(labels).toEqual([...STUDENT_TABLE_COLUMNS]);
    // tooltip 指示器存在（合計折扣需說明基本率與指定課程的差別）
    expect(html).toContain('ⓘ');

    // 位移而非刪除：欄位選擇與明細仍可取得這些值
    expect(labels).not.toContain('人員代碼');
    expect(labels).not.toContain('美語天數');
  });

  it('姓名欄為凍結欄（sticky）', () => {
    const html = render([item()]);
    expect(html).toMatch(/class="[^"]*sticky-name[^"]*"/);
  });
});

describe('UX14：型別不混——0／null／非適用／未設定分開顯示', () => {
  it('安親天數為 null（非適用）與 0（適用但無扣天）分開', () => {
    const html = render([item()]);
    // 課輔 5 天顯示
    expect(html).toContain('>5<');
    // 安親 null 顯示「—」而非 0
    expect(html).toContain('—');
  });

  it('合計折扣對應基本率：顯示收取率短標並附「指定課程可能另有調整」說明', () => {
    const html = render([item({ baseDiscountBps: 9500 })]);
    expect(html).toContain('95折');
    expect(html).toContain('指定課程可能另有調整');
  });

  it('未配置／null 折扣顯示「未設定」而非 100%（UX14：不可把未配置當 100%）', () => {
    const html = render([item({ baseDiscountBps: null, subjectCount: null })]);
    expect(html).toContain('未設定');
    expect(html).not.toContain('無折扣');
  });

  it('已補科數 0 與 null 分開：null 為「無法判定」', () => {
    const zero = render([item({ subjectCount: 0 })]);
    expect(zero).toContain('>0<');
    const none = render([item({ subjectCount: null })]);
    expect(none).toContain('—');
  });

  it('formatBaseDiscount：10000→無折扣、9500→95折、9000→9折、null→未設定', () => {
    expect(formatBaseDiscount(10000)).toBe('無折扣');
    expect(formatBaseDiscount(9500)).toBe('95折');
    expect(formatBaseDiscount(9000)).toBe('9折');
    expect(formatBaseDiscount(null)).toBe('未設定');
    // 與異動判準共用同一格式化（短標一致）
    expect(formatBaseDiscount(9500)).toBe(formatDiscountBps(9500));
  });
});

describe('UX14／09 §5.1：徽章與合計折扣分離', () => {
  it('合計折扣是基本率；選班後的適用率另計，不覆蓋基本率（合計與本班率分開）', () => {
    const html = render([item({ baseDiscountBps: 9500, applicableAnqinBps: 9000, applicableTutoringBps: 9000 })]);
    // 基本率 95折
    expect(html).toContain('95折');
    // 適用率分開呈現，不把 95 折改成 9折
    expect(html).toContain('9折');
  });

  it('無警告時不堆綠色 badge、不宣告帳單已對帳正確（UX15／09 §5.1）', () => {
    const html = render([item({ hasIssues: false, tierMismatch: false })]);
    expect(html).not.toContain('已對帳');
    expect(html).not.toContain('正確');
  });

  it('級距差異徽章不得硬寫筆數（09 §7：預期N人只在 fixture）', () => {
    const html = render([item({ tierMismatch: true })]);
    expect(html).toContain('天數不同');
    // 舊實作的「級距差異 (5筆)」硬寫筆數，必須移除
    expect(html).not.toContain('級距差異 (5筆)');
    expect(html).not.toContain('(5筆)');
  });
});
