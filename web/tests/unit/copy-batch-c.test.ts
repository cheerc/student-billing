import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SummaryTable from '@/components/summary-table';
import { ScheduleGrid } from '@/components/settings/schedule-grid';
import { ImpactDialog } from '@/components/settings/impact-dialog';
import { buildSeedGridRows } from '@/contracts/settings';
import type { StudentCalculationItem } from '@/application/query-students';

/**
 * specs/04 UX32／09 §7（11 C；D39）：使用者可見文案的元件層斷言（靜態轉譯，不需瀏覽器）。
 * 瀏覽器層（真實操作與狀態掃描）見 tests/e2e/copy-d39.spec.ts、copy-scan.spec.ts。
 */

const visible = (html: string) =>
  html
    .replace(/<details[\s\S]*?<\/details>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ');

const withStudentsPreview = {
  mode: 'with_students' as const,
  previewId: 'prev-c-1',
  inputHash: 'hash-c',
  expectedRevision: 1,
  settingsVersionId: 'v2',
  importId: 'imp_c',
  runId: 'run_c',
  totalStudents: 477,
  affectedStudents: 13,
  mismatchBefore: 5,
  mismatchAfter: 17,
  dayDeltas: [{ personCode: 'S001', name: '王小明', before: 5, after: 4.5 }],
};

const dialogProps = {
  isOpen: true,
  mode: 'with_students' as const,
  splitWarnings: [],
  onClose: () => {},
  onApply: () => {},
  applying: false,
};

describe('D39 (1) 課表影響預覽：天數不符的單位是「人」', () => {
  it('顯示「系統計算天數與米豆奶入班天數不符：5 人 → 17 人」，不出現 mismatch 或「筆」', () => {
    const html = renderToStaticMarkup(
      React.createElement(ImpactDialog, { ...dialogProps, preview: withStudentsPreview })
    );
    const text = visible(html);
    expect(text).toContain('系統計算天數與米豆奶入班天數不符：5 人 → 17 人');
    expect(text).not.toMatch(/mismatch/i);
    // 單位是人，不是筆（明細表標題「前 50 筆」是列數，不在此限）
    expect(text).not.toMatch(/→\s*\d+\s*筆/);
  });

  it('數字取自預覽的 before／after，不寫死', () => {
    const html = renderToStaticMarkup(
      React.createElement(ImpactDialog, {
        ...dialogProps,
        preview: { ...withStudentsPreview, mismatchBefore: 0, mismatchAfter: 3 },
      })
    );
    expect(visible(html)).toContain('系統計算天數與米豆奶入班天數不符：0 人 → 3 人');
  });
});

describe('A 批遺留：預覽失敗時確認視窗顯示白話原因，不假裝沒有變更', () => {
  const error = {
    message: '課表有欄位還沒填好或格式不正確（例如星期沒有填）。請先回到課表修正，再按「確認變更」。',
    detail: 'INVALID_DRAFT\n設定草稿格式錯誤：[{"code":"too_small"}]',
  };

  it('顯示白話主文；代碼與原始訊息只在收合的「詳細資訊」；主按鈕不可按；不顯示 0 人／未改變', () => {
    const html = renderToStaticMarkup(
      React.createElement(ImpactDialog, { ...dialogProps, preview: null, error } as never)
    );
    const text = visible(html);
    expect(text).toContain(error.message);
    expect(text).not.toContain('INVALID_DRAFT');
    expect(text).not.toContain('設定草稿格式錯誤');
    expect(text).not.toContain('未改變現行學生的收費天數');
    expect(text).not.toContain('受影響學生數');

    // 詳細資訊：<details>（預設收合、沒有 open 屬性），內含代碼
    const details = html.match(/<details[^>]*>([\s\S]*?)<\/details>/);
    expect(details, '需要可展開的「詳細資訊」').not.toBeNull();
    expect(details![0]).not.toMatch(/<details[^>]*\sopen/);
    expect(details![0]).toContain('詳細資訊');
    expect(details![0]).toContain('INVALID_DRAFT');

    // 錯誤區塊以 role=alert 朗讀
    expect(html).toMatch(/role="alert"[^>]*data-dialog-error|data-dialog-error[^>]*role="alert"/);
    // 主按鈕停用
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>儲存並更新結果<\/button>/);
  });

  it('預覽載入中：不顯示 0 人，也不說「未改變」（未知不可冒充沒有影響）', () => {
    const html = renderToStaticMarkup(
      React.createElement(ImpactDialog, { ...dialogProps, preview: null, loading: true } as never)
    );
    const text = visible(html);
    expect(text).toContain('正在計算');
    expect(text).not.toContain('未改變現行學生的收費天數');
    expect(text).not.toMatch(/0 人/);
  });
});

describe('D39 (2) 課表頁尾', () => {
  it('改為白話取整規則，不含「D24」', () => {
    const html = renderToStaticMarkup(
      React.createElement(ScheduleGrid, {
        rows: buildSeedGridRows(),
        onUpdateRow: () => {},
        onDeleteRow: () => {},
        onAddRow: () => {},
        calculating: false,
        calculateResult: null,
      })
    );
    const foot = html.slice(html.indexOf('class="tablefoot"'));
    const text = visible(foot);
    expect(text).toContain('整班重疊加總後，不足 0.3 天不扣、0.3～0.8 天扣半天、0.8 天以上扣 1 天');
    expect(text).not.toContain('D24');
    expect(visible(html)).not.toMatch(/\bD\d{2}\b/);
  });
});

function studentWithIssues(): StudentCalculationItem {
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
    englishDays: null,
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
    issues: [{ code: 'SCHEDULE_NOT_FOUND', message: '學生報名之數學班級「國小數學-一[團]」未於排課種子中找到，天數採 0 扣天 fallback，待確認排課或 alias 對應。' }],
    hasIssues: true,
    trace: {},
    createdAt: '2026-09-29T10:00:00.000Z',
    enrollments: [],
  } as unknown as StudentCalculationItem;
}

describe('D39 (4) 問題類型只顯示中文名稱', () => {
  it('學生總表「需確認」欄的徽章是中文名稱（排課缺漏），不是英文代碼', () => {
    const html = renderToStaticMarkup(
      React.createElement(SummaryTable, { students: [studentWithIssues()], onSelectStudent: () => {} })
    );
    const tbody = html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'));
    expect(visible(tbody)).toContain('排課缺漏');
    expect(tbody).not.toContain('SCHEDULE_NOT_FOUND');
  });
});
