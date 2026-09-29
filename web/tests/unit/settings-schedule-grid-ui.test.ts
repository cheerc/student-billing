import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import SettingsPage from '@/app/settings/page';
import { WindowSummary } from '@/components/settings/window-summary';
import { ScheduleGrid } from '@/components/settings/schedule-grid';
import { ImpactDialog } from '@/components/settings/impact-dialog';
import { MappingPanel } from '@/components/settings/mapping-panel';
import { buildSeedGridRows } from '@/contracts/settings';
import { CARE_WINDOWS_VIEW } from '@/application/schedule-preview';

/**
 * 09 §2、§3、§6、§7／04 §8 UX01–UX10、UX14–UX16、UX24：
 * R2 展示一（課表主畫面＋即時重疊＋先課表後匯入）UI 元件與頁面測試。
 */

describe('R2 UI 元件與排課工作流程（RED 測試）', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-r2-test-'));
    dbPath = path.join(tempDir, 'test.sqlite');
    process.env.DATABASE_PATH = dbPath;
    const db = createDatabase(dbPath);
    runMigrations(db);
    db.close();
    (global as any).__sqlite_db__ = undefined;
  });

  afterEach(() => {
    if ((global as any).__sqlite_db__) {
      (global as any).__sqlite_db__.close();
      (global as any).__sqlite_db__ = undefined;
    }
    delete process.env.DATABASE_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('UX01／UX24：SettingsPage 初始空狀態（無名單）解除封鎖', () => {
    it('無名單時不再顯示「尚無可設定的名單批次」阻擋卡片，直接呈現課表設定主畫面', async () => {
      const pageElement = await SettingsPage();
      const html = renderToStaticMarkup(pageElement);

      // 不得再包含「尚無可設定的名單批次」空狀態阻擋卡片
      expect(html).not.toContain('尚無可設定的名單批次');
      expect(html).not.toContain('請先上傳 ERP 學生名單後再維護課程');

      // 應包含課表設定頁面標題與預設課表頁籤
      expect(html).toContain('課表設定');
      expect(html).toContain('課表');
      expect(html).toContain('班名對應');
    });
  });

  describe('UX24：WindowSummary 唯讀照顧窗口摘要', () => {
    it('顯示安親 13:00–16:00 與課輔 16:30–19:30 窗口，無輸入框或調整按鈕（D33 窗口固定）', () => {
      const html = renderToStaticMarkup(React.createElement(WindowSummary));

      expect(html).toContain('安親');
      expect(html).toContain('13:00–16:00');
      expect(html).toContain('課輔');
      expect(html).toContain('16:30–19:30');

      // 嚴格唯讀：不可有任何 input 或「調整時段」編輯入口
      expect(html).not.toContain('<input');
      expect(html).not.toContain('調整時段');
    });
  });

  describe('UX05–UX07：ScheduleGrid 平鋪排課網格', () => {
    it('渲染 89 筆時段列，包含左側 5 個編輯欄與右側 5 個唯讀計算欄', () => {
      const seedRows = buildSeedGridRows();
      const html = renderToStaticMarkup(
        React.createElement(ScheduleGrid, {
          rows: seedRows,
          onUpdateRow: () => {},
          onDeleteRow: () => {},
          onAddRow: () => {},
          calculating: false,
          calculateResult: null,
        })
      );

      // 左側編輯欄標頭
      expect(html).toContain('班級名稱');
      expect(html).toContain('帶班老師');
      expect(html).toContain('星期');
      expect(html).toContain('上課時間');

      // 右側唯讀計算欄標頭
      expect(html).toContain('課程時長');
      expect(html).toContain('安親');
      expect(html).toContain('課輔');
      expect(html).toContain('重疊／分');
      expect(html).toContain('扣除／天');

      // 應有 89 筆平鋪時段列
      expect(seedRows).toHaveLength(89);
    });

    it('計算結果尚未回來時，重疊欄顯示「—」而不是 0（未知不可冒充「沒有重疊」，UX07／UX14 型別不混）', () => {
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

      expect(html).toContain('<td class="number cblue">—</td>');
      expect(html).toContain('<td class="number cteal">—</td>');
      expect(html).not.toContain('<td class="number cblue">0</td>');
      expect(html).not.toContain('<td class="number cteal">0</td>');
    });

    it('計算結果回來且確實沒有重疊（no_overlap）時，重疊欄才顯示 0', () => {
      const [row] = buildSeedGridRows();
      const html = renderToStaticMarkup(
        React.createElement(ScheduleGrid, {
          rows: [row],
          onUpdateRow: () => {},
          onDeleteRow: () => {},
          onAddRow: () => {},
          calculating: false,
          calculateResult: {
            requestKey: 'mock-0',
            draftHash: 'hash',
            ruleSetVersion: 'erp-tag-v2',
            windows: CARE_WINDOWS_VIEW,
            rows: [
              {
                rowId: row.rowId,
                classKey: row.className,
                teacher: row.teacher,
                weekday: row.weekday,
                startMinutes: row.startMinutes,
                endMinutes: row.endMinutes,
                durationMinutes: 90,
                anqin: { overlapMinutes: 0, rawDeduction: 0, status: 'no_overlap' },
                tutoring: { overlapMinutes: 0, rawDeduction: 0, status: 'no_overlap' },
              },
            ],
            classes: [],
            issues: [],
          },
        })
      );

      expect(html).toContain('<td class="number cblue">0</td>');
      expect(html).toContain('<td class="number cteal">0</td>');
    });

    it('不完整列（缺起訖時間）時顯示「待補」或警告提示，不崩潰', () => {
      const incompleteRow = {
        rowId: 'row-incomplete-1',
        className: '國小數學-一A',
        teacher: null,
        weekday: '一',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: true,
      };

      const html = renderToStaticMarkup(
        React.createElement(ScheduleGrid, {
          rows: [incompleteRow],
          onUpdateRow: () => {},
          onDeleteRow: () => {},
          onAddRow: () => {},
          calculating: false,
          calculateResult: {
            requestKey: 'mock-1',
            draftHash: 'hash',
            ruleSetVersion: 'erp-tag-v2',
            windows: CARE_WINDOWS_VIEW,
            rows: [
              {
                rowId: 'row-incomplete-1',
                classKey: '國小數學-一A',
                teacher: null,
                weekday: '一',
                startMinutes: null,
                endMinutes: null,
                durationMinutes: null,
                anqin: { overlapMinutes: null, rawDeduction: null, status: 'missing_time' },
                tutoring: { overlapMinutes: null, rawDeduction: null, status: 'missing_time' },
              },
            ],
            classes: [],
            issues: [
              {
                code: 'SCHEDULE_INCOMPLETE',
                classKey: '國小數學-一A',
                rowId: 'row-incomplete-1',
                message: '缺起訖時間',
              },
            ],
          },
        })
      );

      expect(html).toContain('待補');
    });
  });

  describe('UX01／UX04：ImpactDialog 儲存確認視窗', () => {
    it('無學生名單 (settings_only)：提示尚未匯入學生，受影響人數為 null，主按鈕為「儲存課表」', () => {
      const html = renderToStaticMarkup(
        React.createElement(ImpactDialog, {
          isOpen: true,
          mode: 'settings_only',
          preview: {
            mode: 'settings_only',
            previewId: 'prev-so-1',
            inputHash: 'hash1',
            expectedRevision: 0,
            settingsVersionId: 'v1',
            importId: null,
            runId: null,
            totalStudents: null,
            affectedStudents: null,
            mismatchCount: null,
            dayDeltas: null,
          },
          splitWarnings: [],
          onClose: () => {},
          onApply: () => {},
          applying: false,
        })
      );

      // 無學生名單專屬文案
      expect(html).toContain('尚未匯入學生');
      expect(html).toContain('儲存課表');
      expect(html).not.toContain('儲存並更新結果');
    });

    it('有 active 學生 (with_students)：顯示受影響學生人數，主按鈕為「儲存並更新結果」', () => {
      const html = renderToStaticMarkup(
        React.createElement(ImpactDialog, {
          isOpen: true,
          mode: 'with_students',
          preview: {
            mode: 'with_students',
            previewId: 'prev-ws-1',
            inputHash: 'hash2',
            expectedRevision: 1,
            settingsVersionId: 'v2',
            importId: 'imp_1',
            runId: 'run_1',
            totalStudents: 477,
            affectedStudents: 13,
            mismatchCount: 18,
            dayDeltas: [{ personCode: 'S001', name: '王小明', before: 5, after: 4.5 }],
          },
          splitWarnings: [],
          onClose: () => {},
          onApply: () => {},
          applying: false,
        })
      );

      expect(html).toContain('13');
      expect(html).toContain('儲存並更新結果');
      expect(html).toContain('王小明');
    });
  });

  describe('UX10：MappingPanel 班名對應頁籤', () => {
    it('無學生名單時提示「匯入名單後，可確認米豆奶班名」，不阻擋課表', () => {
      const html = renderToStaticMarkup(
        React.createElement(MappingPanel, {
          hasStudents: false,
          candidates: [],
          aliases: [],
          onToggleAlias: () => {},
          onUpdateCandidateTarget: () => {},
        })
      );

      expect(html).toContain('匯入名單後，可確認米豆奶班名');
      expect(html).not.toContain('錯誤');
    });
  });
});
