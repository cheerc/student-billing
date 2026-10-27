import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DetailDrawer from '@/components/detail-drawer';
import type { StudentCalculationItem } from '@/application/query-students';

const TAGS = '有兄弟姊妹折扣, 特殊折扣85折, 園內生';

const base = {
  id: 'calc_synthetic_158', runId: 'run_synthetic_158', personCode: 'SYNTH158', name: '合成折扣說明生',
  branch: '合成分校', grade: 3, gradeRaw: '小三', subjectCount: 2, baseDiscountBps: 8500,
  anqinDays: null, anqinDisplay: '—', tutoringDays: null, tutoringDisplay: '—',
  englishDays: null, mathDays: null, chineseDays: null, homeworkDays: null,
  intensiveEnglishDays: null, saturdayTutoringDays: null,
  applicableAnqinBps: 9000, applicableTutoringBps: 8500, applicableEnglishBps: 8500, applicableMathBps: 8500,
  tierMismatch: false, tierComparisons: [], issues: [], hasIssues: false,
  actionableIssues: [], actionableHasIssues: false,
  trace: { rawTags: TAGS }, createdAt: '2026-10-24T00:00:00.000Z',
  enrollments: [], sourceRow: 2, classText: null,
};

function discountBlock(html: string): string {
  const start = html.indexOf('折扣推導');
  const end = html.indexOf('課程與扣天', start);
  return html.slice(start, end < 0 ? html.length : end);
}

function render(overrides: Record<string, unknown> = {}, ruleSetVersion: string | null = 'erp-tag-v4') {
  const html = renderToStaticMarkup(React.createElement(DetailDrawer, {
    student: { ...base, ...overrides } as unknown as StudentCalculationItem,
    onClose: () => {},
  }));
  return discountBlock(html);
}

describe('Issue #158：學生明細說明已保存折扣推導', () => {
  it('v4 顯示四項因素、命中標籤短語、級距步驟與已保存各課程結果', () => {
    const html = render();

    expect(html).toContain('列入折扣的科數');
    expect(html).toContain('兄弟姊妹折扣');
    expect(html).toContain('有兄弟姊妹折扣');
    expect(html).toContain('2 + 1 = 3 科');
    expect(html).toContain('特殊折扣85折');
    expect(html).toContain('優先採用');
    expect(html).toContain('園內生');
    expect(html).toContain('僅調整安親');
    expect(html).toContain('最低收費率為 9 折');
    expect(html).toContain('基本折扣率');
    expect(html).toContain('85折');
    expect(html).toContain('安親: 9折');
    expect(html).toContain('課輔: 85折');
    expect(html).toContain('美語: 85折');
    expect(html).toContain('數學: 85折');
    expect(html).toContain('不代表已報讀該課程');
    expect(html).not.toContain(TAGS);
    expect(html).not.toContain('bps');
  });

  it('沒有優惠標籤時兄弟姊妹、特殊折扣、園內生都明確顯示「無」', () => {
    const html = render({
      trace: { rawTags: null },
      subjectCount: 1,
      baseDiscountBps: 10000,
      applicableAnqinBps: 10000,
      applicableTutoringBps: 10000,
      applicableEnglishBps: 10000,
      applicableMathBps: 10000,
    });

    expect(html).toContain('兄弟姊妹折扣：<strong>無</strong>');
    expect(html).toContain('特殊折扣：<strong>無</strong>');
    expect(html).toContain('園內生：<strong>無</strong>');
  });

  it('無報名與 0 科不同，且無報名學生的適用率 null 保留為「—」', () => {
    const noEnrollment = render({
      subjectCount: null,
      baseDiscountBps: 10000,
      applicableAnqinBps: null,
      applicableTutoringBps: null,
      applicableEnglishBps: null,
      applicableMathBps: null,
      trace: { rawTags: '有兄弟姊妹折扣' },
    });
    const zeroSubjects = render({
      subjectCount: 0,
      baseDiscountBps: 10000,
      applicableAnqinBps: 10000,
      applicableTutoringBps: 10000,
      applicableEnglishBps: 10000,
      applicableMathBps: 10000,
      trace: { rawTags: '' },
    });

    expect(noEnrollment).toContain('無報名');
    expect(noEnrollment).toContain('不計算科數級距');
    expect(noEnrollment).toContain('安親: —');
    expect(zeroSubjects).toContain('0 科');
    expect(zeroSubjects).not.toContain('無報名');
  });



  it('缺少 trace.rawTags 時明示來源不足，且不斷言因素有或無', () => {
    const html = render({ trace: {} });
    expect(html).toContain('標籤來源資料不足，無法還原本次折扣推導');
    expect(html).not.toMatch(/兄弟姊妹折扣[：:]\s*(有|無)/);
  });

  it('v4 保存值不一致時保留已存率並隱藏未驗證的因素鏈', () => {
    const html = render({ baseDiscountBps: 9000 });
    expect(html).toContain('無法依已保存資訊完整還原本次推導，請人工核對');
    expect(html).toContain('9折');
    expect(html).not.toMatch(/兄弟姊妹折扣[：:]\s*有/);
  });
});
