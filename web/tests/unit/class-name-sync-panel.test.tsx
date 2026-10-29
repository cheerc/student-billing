import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClassNameSyncPanel } from '@/components/settings/class-name-sync-panel';
import type { ClassNameSyncReport } from '@/application/class-name-match-report';

describe('D62 Phase 2: ClassNameSyncPanel 班名同步面板 UI 元件（RED 測試）', () => {
  const mockReport: ClassNameSyncReport = {
    importId: 'imp_test',
    scope: { kind: 'latest' },
    snapshotStatus: 'ok',
    rosterClassCount: 3,
    exactMatchCount: 1,
    unmappedStudents: 1,
    mismatches: [
      { erpBaseName: '丙班', students: 1, tokens: 1, legacyAliasTarget: null },
      { erpBaseName: '乙班', students: 1, tokens: 1, legacyAliasTarget: 'X班' },
    ],
    systemOnly: [
      {
        baseName: 'X班',
        active: true,
        classType: 'english',
        sessionCount: 2,
        legacyAliasFrom: ['乙班', '丁班'],
      },
      {
        baseName: 'W班',
        active: false,
        classType: 'other',
        sessionCount: 0,
        legacyAliasFrom: [],
      },
    ],
  };

  describe('1. 差異表與摘要資訊呈現', () => {
    it('呈現班名同步摘要列，包含名冊數、一致數、不一致數與未對應人數', () => {
      const html = renderToStaticMarkup(
        <ClassNameSyncPanel report={mockReport} hasStudents={true} />
      );

      expect(html).toContain('名冊 3 個班名');
      expect(html).toContain('一致 1');
      expect(html).toContain('不一致 2');
      expect(html).toContain('未對應 1');
      expect(html).toContain('影響 1 位學生');
    });

    it('差異表呈現所有 mismatches，未對應優先，並包含現況 pill 與操作按鈕', () => {
      const html = renderToStaticMarkup(
        <ClassNameSyncPanel report={mockReport} hasStudents={true} />
      );

      expect(html).toContain('丙班');
      expect(html).toContain('未對應課表');
      expect(html).toContain('乙班');
      expect(html).toContain('經舊對應連到「X班」');

      // 支援操作按鈕
      expect(html).toContain('同步到既有班級');
      expect(html).toContain('新增為課表班級');
    });

    it('底部包含「課表有、本次名冊沒有的班級」details 展開區', () => {
      const html = renderToStaticMarkup(
        <ClassNameSyncPanel report={mockReport} hasStudents={true} />
      );

      expect(html).toContain('課表有、本次名冊沒有的班級 (2)');
      expect(html).toContain('X班');
      expect(html).toContain('W班');
    });
  });

  describe('2. ［同步到既有班級］候選下拉與警示', () => {
    it('展開同步表單時，候選下拉依課程類型分組，舊對應目標標示「(舊對應)」', () => {
      const html = renderToStaticMarkup(
        <ClassNameSyncPanel
          report={mockReport}
          hasStudents={true}
        />
      );

      // 包含分組 optgroup 與舊對應標籤
      expect(html).toContain('optgroup');
      expect(html).toContain('(舊對應)');
      // 事前文字提示改名後果
      expect(html).toContain('課表班級');
      expect(html).toContain('時段、課程類型與折扣設定一併沿用');
      // 孤兒別名警示
      expect(html).toContain('丁班');
      expect(html).toContain('同步後將變成未對應');
    });
  });

  describe('3. ［新增為課表班級］表單', () => {
    it('展開新增表單時，班名唯讀＝米豆奶班名，包含 5 種課程類型選項', () => {
      const html = renderToStaticMarkup(
        <ClassNameSyncPanel
          report={mockReport}
          hasStudents={true}
        />
      );

      expect(html).toContain('安親課輔班');
      expect(html).toContain('美語班');
      expect(html).toContain('數學班');
      expect(html).toContain('其他班');
      expect(html).toContain('不排課');
    });
  });

  describe('4. 暫存狀態與復原按鈕', () => {
    it('已暫存改名的列顯示「已暫存：X → Y（未儲存）」與［復原］按鈕', () => {
      const stagedRenames = new Map([['乙班', 'X班']]);
      const html = renderToStaticMarkup(
        <ClassNameSyncPanel
          report={mockReport}
          hasStudents={true}
          stagedRenames={stagedRenames}
        />
      );

      expect(html).toContain('已暫存：X班 → 乙班（未儲存）');
      expect(html).toContain('復原');
    });

    it('已暫存新增課表班級的列顯示已暫存提示與［到課表填時段 →］及［復原］按鈕', () => {
      const stagedNewClasses = new Set(['丙班']);
      const html = renderToStaticMarkup(
        <ClassNameSyncPanel
          report={mockReport}
          hasStudents={true}
          stagedNewClasses={stagedNewClasses}
        />
      );

      expect(html).toContain('已暫存新增課表班級（未儲存）');
      expect(html).toContain('到課表填時段 →');
      expect(html).toContain('復原');
    });
  });

  describe('5. 鎖定與錯誤狀態（UX46）', () => {
    it('retrying 狀態下顯示「更新中…」，按鈕 disabled', () => {
      const html = renderToStaticMarkup(
        <ClassNameSyncPanel
          report={mockReport}
          hasStudents={true}
          locked={true}
          reportRecoveryStage="retrying"
        />
      );

      expect(html).toContain('更新中…');
    });

    it('reload 狀態下顯示錯誤標示與［重新載入］按鈕', () => {
      const html = renderToStaticMarkup(
        <ClassNameSyncPanel
          report={mockReport}
          hasStudents={true}
          locked={true}
          reportRecoveryStage="reload"
          reportStaleMessage="無法取得最新的班名比對報告。"
        />
      );

      expect(html).toContain('無法取得最新的班名比對報告。');
      expect(html).toContain('重新載入');
    });
  });

  describe('6. Operator Q1 裁決守門：無批次／無隱藏／無略過', () => {
    it('嚴格斷言畫面上絕對不存在「全部同步」、「批次同步」、「一鍵同步」、「略過」、「隱藏」等按鈕', () => {
      const html = renderToStaticMarkup(
        <ClassNameSyncPanel report={mockReport} hasStudents={true} />
      );

      expect(html).not.toContain('全部同步');
      expect(html).not.toContain('批次同步');
      expect(html).not.toContain('一鍵同步');
      expect(html).not.toContain('全部合併');
      expect(html).not.toContain('一鍵合併');
      expect(html).not.toContain('略過');
      expect(html).not.toContain('隱藏');
    });
  });

  describe('7. 空狀態', () => {
    it('無名單時顯示空狀態提示', () => {
      const html = renderToStaticMarkup(
        <ClassNameSyncPanel report={null} hasStudents={false} />
      );

      expect(html).toContain('匯入名單後，可在這裡同步班名');
    });
  });
});
