import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DetailDrawer from '@/components/detail-drawer';
import { issueMessage } from '@/lib/issue-copy';
import type { StudentCalculationItem } from '@/application/query-students';

const { injectedClassNotMappedMessage } = vi.hoisted(() => ({
  injectedClassNotMappedMessage: '測試注入指引：請到課表設定 → 班名同步確認（動態來源 #201）',
}));

// 動態替換 source 的輸出：若抽屜只是手動複製目前字串，測試仍會失敗；
// 只有實際透過 issueMessage() 取得 CLASS_NOT_MAPPED 指引時才會顯示此哨兵文案。
vi.mock('@/lib/issue-copy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/issue-copy')>();
  return {
    ...actual,
    issueMessage: (issue: { code: string }) =>
      issue.code === 'CLASS_NOT_MAPPED' ? injectedClassNotMappedMessage : actual.issueMessage(issue),
  };
});

/**
 * Issue #201：同一個 `CLASS_NOT_MAPPED` 的「下一步指示」在結果頁問題清單與明細抽屜
 * 只能有一份來源（`web/src/lib/issue-copy.ts`）。
 *
 * 缺陷：`detail-drawer.tsx` 的級距比對列另外手寫了一句舊文案「…請確認米豆奶班名或系統班級名稱。」，
 * 沒有走 `issue-copy`；而同一支抽屜上方待確認事項已由 `issueMessage()` 顯示新引導。
 * 結果是同一畫面出現兩套下一步指示，且 #189 P3 改文案時只有 `issue-copy` 被更新。
 *
 * 預期值一律以程式取值（`issueMessage({ code: 'CLASS_NOT_MAPPED' })`），不手抄字串；
 * 這樣斷言檢查的是「兩處共用同一份文案」，而不是「剛好寫了某句話」。
 */

const expectedGuidance = issueMessage({ code: 'CLASS_NOT_MAPPED' });

const base = {
  id: 'c1', runId: 'run_1', personCode: 'STU_SYNTHETIC', name: '合成未對應生',
  branch: '合成分校', grade: '三年級', gradeRaw: '三年級',
  subjectCount: 1, baseDiscountBps: 10000,
  anqinDays: null, anqinDisplay: null, tutoringDays: null, tutoringDisplay: null,
  englishDays: null, mathDays: null, chineseDays: null, homeworkDays: null,
  intensiveEnglishDays: null, saturdayTutoringDays: null,
  applicableAnqinBps: null, applicableTutoringBps: null,
  applicableEnglishBps: null, applicableMathBps: null,
  tierMismatch: false, tierComparisons: [], issues: [], hasIssues: false,
  actionableIssues: [], actionableHasIssues: false,
  trace: { rawTags: '' }, createdAt: '2026-11-02T00:00:00.000Z',
  enrollments: [], sourceRow: 2, classText: null,
};

/** 只有 `CLASS_NOT_MAPPED` 的級距比對列（與 `billing-calculator` 的 comp 形狀一致）。 */
const unmappedComparison = {
  enrollmentId: 'e1',
  rawToken: '國小數學-合成班',
  baseName: '國小數學-合成班',
  computedTier: 0,
  erpDeclaredTier: 0,
  status: 'unavailable' as const,
  needsReview: true,
  issues: ['CLASS_NOT_MAPPED'],
};

const renderDrawer = (over: Partial<StudentCalculationItem>) =>
  renderToStaticMarkup(
    React.createElement(DetailDrawer, {
      student: { ...base, ...over } as StudentCalculationItem,
      onClose: () => {},
    })
  );

/**
 * 級距比對區塊（本次缺陷所在）。不取整份 HTML 是因為底部「原始資料」摺疊區
 * 會 JSON.stringify 整筆 student，裡面本來就有原始 issue message 與代碼（D39 允許）。
 */
function tierComparisonBlock(html: string): string {
  const start = html.indexOf('米豆奶登記級距比對');
  expect(start, '找不到「米豆奶登記級距比對」區塊').toBeGreaterThan(-1);
  const end = html.indexOf('原始資料', start);
  return html.slice(start, end === -1 ? html.length : end);
}

describe('#201：抽屜的 CLASS_NOT_MAPPED 引導句與 issue-copy 同一來源', () => {
  it('級距比對列的引導句等於 issueMessage(CLASS_NOT_MAPPED)，不是另寫一份舊文案', () => {
    const block = tierComparisonBlock(
      renderDrawer({
        issues: [{ code: 'CLASS_NOT_MAPPED', message: '學生報名之班級「國小數學-合成班」班名未對應課表。' }],
        actionableIssues: [{ code: 'CLASS_NOT_MAPPED', message: '學生報名之班級「國小數學-合成班」班名未對應課表。' }],
        hasIssues: true,
        actionableHasIssues: true,
        tierComparisons: [unmappedComparison],
      })
    );

    expect(block).toContain(`⚠ ${expectedGuidance}`);
    // 舊句的接續詞只在舊文案出現；新引導句是「請到「課表設定 → 班名同步」確認」。
    expect(block).not.toContain('，請確認米豆奶班名');
  });

  it('抽屜內的兩個位置（待確認事項與級距比對）指向同一句引導', () => {
    const html = renderDrawer({
      issues: [{ code: 'CLASS_NOT_MAPPED', message: '班名未對應課表' }],
      actionableIssues: [{ code: 'CLASS_NOT_MAPPED', message: '班名未對應課表' }],
      hasIssues: true,
      actionableHasIssues: true,
      tierComparisons: [unmappedComparison],
    });

    const occurrences = html.split(expectedGuidance).length - 1;
    expect(occurrences, '待確認事項與級距比對列應各顯示一次同一句引導').toBe(2);
  });

  it('非 CLASS_NOT_MAPPED 的需確認列仍保留原有的相容比較說明', () => {
    const block = tierComparisonBlock(
      renderDrawer({
        tierComparisons: [
          {
            ...unmappedComparison,
            issues: ['UNKNOWN_WEEKDAY'],
            rawToken: '兒童美語-合成班',
          },
        ],
      })
    );

    expect(block).toContain('⚠ 排課缺漏，暫以相容數值比較，請核對課表設定。');
    expect(block).not.toContain(expectedGuidance);
  });
});
