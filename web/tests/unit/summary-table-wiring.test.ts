import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SummaryTable from '@/components/summary-table';
import type { StudentCalculationItem } from '@/application/query-students';
import type { RunClassCategorySnapshot } from '@/application/applicable-rate';

describe('Ruling 4: SummaryTable ruleSetVersion 與快照接線防回歸單元測試', () => {
  const dummyStudent: StudentCalculationItem = {
    personCode: 'S_TEST',
    name: '測試生',
    branch: '本校',
    grade: 4,
    subjectCount: 1,
    baseDiscountBps: 10000,
    anqinDays: null,
    tutoringDays: 5,
    applicableAnqinBps: null,
    applicableTutoringBps: 10000,
    applicableMathBps: null,
    applicableEnglishBps: null,
    tierMismatch: false,
    hasIssues: false,
    anqinDisplay: '—',
    tutoringDisplay: '5',
    issues: [],
    tierComparisons: [],
    enrollments: [
      {
        rawToken: '國小輔導-寫功課[團]',
        baseName: '國小輔導-寫功課',
        yearPrefix: null,
        groupFlag: '團',
        modifiers: [],
        withdrawalDate: null,
        erpBillingTierRaw: null,
        erpBillingTier: null,
        tierParseStatus: 'not_applicable',
        parseStatus: 'ok',
      },
    ],
    trace: { rawTags: '' },
    createdAt: new Date().toISOString(),
  };

  const snapshots: RunClassCategorySnapshot[] = [
    {
      base_name: '國小輔導-寫功課',
      category: 'none',
      fixed_five_days: 1,
    },
  ];

  it('1. 當傳入 ruleSetVersion="erp-tag-v4" 且班級為 none（固定 5 天）時，本班適用折扣正確渲染「未設定」而非「無折扣」', () => {
    const html = renderToStaticMarkup(
      React.createElement(SummaryTable, {
        students: [dummyStudent],
        singleClass: '國小輔導-寫功課',
        classCategorySnapshots: snapshots,
        ruleSetVersion: 'erp-tag-v4',
        onSelectStudent: () => {},
      })
    );

    expect(html).toContain('未設定');
    expect(html).not.toContain('無折扣');
  });

  it('2. 當傳入 ruleSetVersion="erp-tag-v3" 且班級為 none（固定 5 天）時，維持 v3 行為渲染「無折扣」（10000 bps）', () => {
    const html = renderToStaticMarkup(
      React.createElement(SummaryTable, {
        students: [dummyStudent],
        singleClass: '國小輔導-寫功課',
        classCategorySnapshots: snapshots,
        ruleSetVersion: 'erp-tag-v3',
        onSelectStudent: () => {},
      })
    );

    expect(html).toContain('無折扣');
    expect(html).not.toContain('未設定');
  });
});
