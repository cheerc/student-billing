import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScheduleGrid } from '@/components/settings/schedule-grid';
import { ImpactDialog } from '@/components/settings/impact-dialog';
import { buildSeedGridRows } from '@/contracts/settings';

/**
 * D62 Phase 2：課表頁單行不一致橫幅與 ImpactDialog「班名同步」區塊。
 * 舊 roster-only 表與 pendingRosterOnlyClass 路徑已移除（specs/17 §4 P2）。
 */

describe('D62 Phase 2：ScheduleGrid 班名不一致橫幅', () => {
  it('顯示「名冊有 N 個班名與課表不一致（其中 M 個尚未對應，影響 K 位學生）前往班名同步 →」', () => {
    const html = renderToStaticMarkup(
      React.createElement(ScheduleGrid, {
        rows: buildSeedGridRows(),
        onUpdateRow: () => {},
        onDeleteRow: () => {},
        onAddRow: () => {},
        calculating: false,
        calculateResult: null,
        syncSummary: { mismatchCount: 12, unmappedCount: 11, unmappedStudents: 191 },
        onGoToSync: () => {},
      })
    );

    expect(html).toContain('data-schedule-sync-banner');
    expect(html).toContain('名冊有 12 個班名與課表不一致');
    expect(html).toContain('其中 11 個尚未對應');
    expect(html).toContain('影響 191 位學生');
    expect(html).toContain('前往班名同步');
  });

  it('舊 roster-only 表與「加入課表設定」按鈕已完全移除', () => {
    const html = renderToStaticMarkup(
      React.createElement(ScheduleGrid, {
        rows: buildSeedGridRows(),
        onUpdateRow: () => {},
        onDeleteRow: () => {},
        onAddRow: () => {},
        calculating: false,
        calculateResult: null,
        syncSummary: { mismatchCount: 1, unmappedCount: 1, unmappedStudents: 3 },
        onGoToSync: () => {},
      })
    );

    expect(html).not.toContain('data-roster-only-section');
    expect(html).not.toContain('data-roster-only-class');
    expect(html).not.toContain('加入課表設定');
    expect(html).not.toContain('名單中有');
  });

  it('不一致為 0 或不提供摘要時不顯示橫幅', () => {
    const zero = renderToStaticMarkup(
      React.createElement(ScheduleGrid, {
        rows: buildSeedGridRows(),
        onUpdateRow: () => {},
        onDeleteRow: () => {},
        onAddRow: () => {},
        calculating: false,
        calculateResult: null,
        syncSummary: { mismatchCount: 0, unmappedCount: 0, unmappedStudents: 0 },
      })
    );
    const none = renderToStaticMarkup(
      React.createElement(ScheduleGrid, {
        rows: buildSeedGridRows(),
        onUpdateRow: () => {},
        onDeleteRow: () => {},
        onAddRow: () => {},
        calculating: false,
        calculateResult: null,
      })
    );

    expect(zero).not.toContain('data-schedule-sync-banner');
    expect(none).not.toContain('data-schedule-sync-banner');
  });
});

describe('D62 Phase 2：ImpactDialog 班名同步區塊', () => {
  const preview = {
    mode: 'with_students' as const,
    previewId: 'p1',
    inputHash: 'h1',
    expectedRevision: 1,
    settingsVersionId: 'v1',
    importId: 'imp1',
    runId: 'run1',
    totalStudents: 10,
    affectedStudents: 0,
    dayDeltas: null,
  };

  it('列出整班同步改名 X → Y 與新增班級', () => {
    const html = renderToStaticMarkup(
      React.createElement(ImpactDialog, {
        isOpen: true,
        mode: 'with_students',
        preview,
        splitWarnings: [],
        syncSummary: {
          renames: [{ from: 'X班', to: '乙班' }],
          news: [{ name: '交通車', classType: '不排課' }],
        },
        onClose: () => {},
        onApply: () => {},
        applying: false,
      })
    );

    expect(html).toContain('data-sync-impact-summary');
    expect(html).toContain('班名同步與新增變更');
    expect(html).toContain('X班');
    expect(html).toContain('乙班');
    expect(html).toContain('沿用原時段、課程類型與折扣');
    expect(html).toContain('交通車');
    expect(html).toContain('不排課');
  });

  it('沒有任何同步或新增時不顯示該區塊', () => {
    const html = renderToStaticMarkup(
      React.createElement(ImpactDialog, {
        isOpen: true,
        mode: 'with_students',
        preview,
        splitWarnings: [],
        syncSummary: { renames: [], news: [] },
        onClose: () => {},
        onApply: () => {},
        applying: false,
      })
    );

    expect(html).not.toContain('data-sync-impact-summary');
  });
});
