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

      expect(html).toContain('<td class="number cblue" data-calc="anqin-overlap">—</td>');
      expect(html).toContain('<td class="number cteal" data-calc="tutoring-overlap">—</td>');
      expect(html).not.toContain('<td class="number cblue" data-calc="anqin-overlap">0</td>');
      expect(html).not.toContain('<td class="number cteal" data-calc="tutoring-overlap">0</td>');
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

      expect(html).toContain('<td class="number cblue" data-calc="anqin-overlap">0</td>');
      expect(html).toContain('<td class="number cblue" data-calc="anqin-deduction">0</td>');
    });

    it('不完整列（缺起訖時間）時平靜顯示「—」且對螢讀可讀為「未設定時間」，不崩潰（#82；decision d-20261004093019108435-11）', () => {
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
        skipDeduction: false,
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

      // #82：不再顯示「待補」badge，改為平靜的「—」＋ aria-label「未設定時間」
      expect(html).not.toContain('待補');
      expect(html).not.toContain('badge-incomplete');
      // 5 個計算欄位（時長 + 安親×2 + 課輔×2）
      // 五個計算欄各有可聚焦的「未設定時間」說明按鈕（不是只靠 title 的 hover）
      expect(html.match(/aria-label="未設定時間"/g)?.length).toBe(5);
      expect(html).not.toContain('title="未設定時間"');
      expect(html).toMatch(/<button[^>]*aria-label="未設定時間"/);
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

    /**
     * UX46／operator 裁決 d-20261002162913018695-69（review B-1）：
     * 自動重試期間不得顯示**儲存前的舊報告數字**，也不得顯示錯誤樣式；
     * 改顯示一行中性佔位「更新中…」，候選表同時鎖定。
     */
    it('retrying：報告區顯示「更新中…」佔位，不渲染儲存前的舊報告、不顯示錯誤', () => {
      const staleReport = {
        snapshotStatus: 'ok',
        reviewImportId: 'import-1',
        rosterOnly: [{ baseName: '交通車', students: 93, tokens: 93 }],
        rosterOnlyStudents: 93,
        systemOnly: [],
      } as never;

      const html = renderToStaticMarkup(
        React.createElement(MappingPanel, {
          hasStudents: true,
          candidates: [],
          aliases: [],
          onToggleAlias: () => {},
          onUpdateCandidateTarget: () => {},
          classNameReport: staleReport,
          reportRecoveryStage: 'retrying',
          candidatesLocked: true,
        })
      );

      expect(html).toContain('更新中');
      expect(html).not.toContain('交通車');
      expect(html).not.toContain('個班');
      expect(html).not.toContain('無法取得最新的班名比對報告');
      expect(html).not.toContain('alert-warning');
      expect(html).toContain('aria-disabled="true"');
      expect(html).toContain('disabled');
    });

    it('reload：顯示單行「無法取得最新的班名比對報告。」＋［重新載入］，不渲染舊報告', () => {
      const staleReport = {
        snapshotStatus: 'ok',
        reviewImportId: 'import-1',
        rosterOnly: [{ baseName: '交通車', students: 93, tokens: 93 }],
        rosterOnlyStudents: 93,
        systemOnly: [],
      } as never;

      const html = renderToStaticMarkup(
        React.createElement(MappingPanel, {
          hasStudents: true,
          candidates: [],
          aliases: [],
          onToggleAlias: () => {},
          onUpdateCandidateTarget: () => {},
          classNameReport: staleReport,
          classNameReportStaleMessage: '無法取得最新的班名比對報告。',
          reportRecoveryStage: 'reload',
          candidatesLocked: true,
        })
      );

      expect(html).toContain('無法取得最新的班名比對報告。');
      expect(html).toContain('重新載入');
      expect(html).not.toContain('交通車');
      expect(html).toContain('aria-disabled="true"');
    });
  });
});

describe('Issue #157 PR-2：Schedule tab roster-only classes', () => {
  it('shows report classes and disables add while the report is stale', () => {
    const html = renderToStaticMarkup(
      React.createElement(ScheduleGrid, {
        rows: buildSeedGridRows(),
        onUpdateRow: () => {},
        onDeleteRow: () => {},
        onAddRow: () => {},
        calculating: false,
        calculateResult: null,
        rosterOnlyClasses: [{ baseName: '國小數學-一', students: 3, tokens: 4 }],
        rosterOnlyLocked: true,
        rosterOnlyStaleMessage: '無法取得最新的班名比對報告。',
      })
    );

    expect(html).toContain('aria-label="名單中尚未加入課表設定的班級"');
    expect(html).toContain('data-roster-only-class="國小數學-一"');
    expect(html).toContain('3 位');
    expect(html).toContain('<td>4</td>');
    expect(html).toContain('尚未加入課表設定');
    expect(html).toContain('data-roster-only-stale');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>加入課表設定<\/button>/);
  });
});
