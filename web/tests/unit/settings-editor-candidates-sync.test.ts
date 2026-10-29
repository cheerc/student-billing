import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClassNameSyncPanel } from '@/components/settings/class-name-sync-panel';
import type { ClassNameSyncReport } from '@/application/class-name-match-report';

/**
 * #189 D62：設定頁不再從 `rosterOnly` 建立可編輯候選；班名同步直接呈現 read model 的 `mismatches`。
 * 「名冊有、課表無完全同名」為嚴格比對狀態，舊別名只顯示現況，不代表班名已一致。
 */
describe('N09: 班名同步差異表使用嚴格同名報告（UX70／D62）', () => {
  const report: ClassNameSyncReport = {
    importId: 'imp_sync',
    scope: { kind: 'latest' },
    snapshotStatus: 'ok',
    rosterClassCount: 4,
    exactMatchCount: 1,
    unmappedStudents: 7,
    mismatches: [
      { erpBaseName: '交通車', students: 5, tokens: 7, legacyAliasTarget: '兒童美語-Ali' },
      { erpBaseName: '國小數學-一', students: 2, tokens: 2, legacyAliasTarget: null },
    ],
    systemOnly: [
      {
        baseName: '兒童美語-Ali',
        active: true,
        classType: 'english',
        sessionCount: 2,
        legacyAliasFrom: ['交通車'],
      },
    ],
  };

  it('頁籤內容列出每筆 mismatches；舊別名僅標示現況，不被當作完全同名', () => {
    const html = renderToStaticMarkup(
      React.createElement(ClassNameSyncPanel, { report, hasStudents: true })
    );

    const mismatches = report.mismatches ?? [];
    expect(html.match(/data-mismatch-row=/g)).toHaveLength(mismatches.length);
    expect(html).toContain('交通車');
    expect(html).toContain('經舊對應連到「兒童美語-Ali」');
    expect(html).toContain('國小數學-一');
    expect(html).toContain('未對應課表');
    expect(html).toContain('不一致 2');
    expect(html).toContain('未對應 1');
    expect(html).not.toContain('input-target-classname');
    expect(html).not.toContain('candidateTargets');
  });

  it('候選來源清單只供同步目標選擇與唯讀檢視，不將舊 alias 視為 exact match', () => {
    const html = renderToStaticMarkup(
      React.createElement(ClassNameSyncPanel, {
        report,
        hasStudents: true,
        defaultExpandedRow: { erpBaseName: '交通車', mode: 'sync' },
      })
    );

    expect(html).toContain('兒童美語-Ali');
    expect(html).toContain('(舊對應)');
    expect(html).toContain('選擇同步目標課表班級');
    expect(html).toContain('同步到既有班級');
    expect(html).not.toContain('建立別名');
  });
});
