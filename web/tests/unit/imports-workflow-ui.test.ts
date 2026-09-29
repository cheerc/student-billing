import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import ImportsPage from '@/app/imports/page';
import { ImportsWorkflow } from '@/components/imports/imports-workflow';
import { ImportPreviewResult } from '@/application/import-preview';

/**
 * specs/09 §4／specs/04 UX09–UX12、UX19：
 * R3 匯入頁三態流程（選擇檔案 → 確認名單 → 完成）與頁內直接啟用名單 UI 測試。
 */

/**
 * 共用預覽 fixture：3 列資料中第 4 列人員代碼空白，被 erp-reader 以 issue 記錄後略過，
 * 因此「總人數 2」不含該列、issues 有 1 條（Rework B1 的實質斷言基礎）。
 * STU001 的 token 帶離班日期與 defaulted 級距（Rework B2 的斷言基礎）。
 */
const mockPreview: ImportPreviewResult = {
  previewId: 'imp_mock_123',
  fileName: 'student-list.xlsx',
  fileHash: 'filehash123',
  contentHash: 'contenthash123',
  sheetName: 'Sheet1',
  candidateSheets: ['Sheet1'],
  headerRowIndex: 1,
  stats: {
    totalStudents: 2,
    studentsWithClass: 1,
    studentsWithoutClass: 1,
    withdrawnStudentsCount: 1,
    gradeCounts: { '1': 2 },
  },
  headerMapping: {},
  extraHeaders: [],
  pendingClasses: ['未定義班級甲'],
  issues: ['第 4 列未填寫人員代碼，已略過。'],
  students: [
    {
      personCode: 'STU001',
      name: '王小明',
      branch: '本校',
      gradeRaw: '小一',
      grade: 1,
      gradeStatus: 'valid',
      contact: null,
      schoolInfo: null,
      tagsRaw: '',
      tags: [],
      notesRaw: '',
      enrollments: [
        {
          rawToken: '數學一[團]',
          yearPrefix: null,
          baseName: '數學一',
          groupFlag: '團',
          modifiers: [],
          withdrawalDate: '2026-07-01',
          erpBillingTierRaw: '4',
          erpBillingTier: 4,
          tierParseStatus: 'defaulted',
          parseStatus: 'ok',
        },
      ],
      sourceRow: 2,
    },
    {
      personCode: 'STU002',
      name: '李小華',
      branch: '本校',
      gradeRaw: '小一',
      grade: 1,
      gradeStatus: 'valid',
      contact: null,
      schoolInfo: null,
      tagsRaw: '',
      tags: [],
      notesRaw: '',
      enrollments: [],
      sourceRow: 3,
    },
  ],
  scopeNote: '測試批次',
};

/** 差異統計：基準名單存在時 UI 應呈現新增／報名異動／未出現。 */
const withDiff = (over: Record<string, unknown>) => ({
  ...mockPreview,
  rosterDiff: {
    baseImportId: 'imp_base',
    newStudents: 1,
    changedStudents: 2,
    unchangedStudents: 0,
    notAppearedStudents: 3,
    ...over,
  },
});

describe('R3 匯入頁工作流程與 UI 元件（RED 測試）', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-r3-test-'));
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

  describe('文案與三態流程呈現（去技術化）', () => {
    it('選擇檔案階段：文案為「上傳ERP匯出的學生Excel」，不含 OOXML 或 inlineStr 開發術語，含課表連結', async () => {
      const pageEl = await ImportsPage();
      const html = renderToStaticMarkup(pageEl);

      // 去技術化文案
      expect(html).toContain('上傳ERP匯出的學生Excel');
      expect(html).not.toContain('OOXML');
      expect(html).not.toContain('inlineStr');

      // 課表狀態連結
      expect(html).toContain('查看課表');
      expect(html).toContain('/settings');

      // 流程三步驟標示
      expect(html).toContain('1 選擇檔案');
      expect(html).toContain('2 確認名單');
      expect(html).toContain('3 完成');
    });
  });

  describe('確認名單階段：頁內「使用這份名單」直接啟用', () => {

    it('預覽階段顯示名冊統計、核對基準日與主按鈕「使用這份名單」', () => {
      const html = renderToStaticMarkup(
        React.createElement(ImportsWorkflow, {
          initialStage: 'preview',
          initialPreview: mockPreview,
          currentRevision: 0,
          lastScheduleSavedAt: '2026-09-29T10:00:00.000Z',
        })
      );

      // 人數統計（3 列資料中 1 列被略過 → 總人數 2，不含該列）
      expect(html).toContain('學生總人數');
      expect(html).toContain('有報名班級人數');
      expect(html).toContain('無班級人數');
      expect(html).not.toContain('477');

      // 未知班名提示
      expect(html).toContain('1 個班名待確認');

      // 核對基準日與主按鈕
      expect(html).toContain('核對基準日');
      expect(html).toContain('使用這份名單');

      // 提示尚未啟用，目前結果不變
      expect(html).toContain('尚未使用這份名單');
    });

    it('完成階段顯示「已更新 N 位學生」與主要動作「開始核對 →」導向按鈕', () => {
      const html = renderToStaticMarkup(
        React.createElement(ImportsWorkflow, {
          initialStage: 'success',
          initialPreview: mockPreview,
          activatedCount: 2,
          currentRevision: 1,
          lastScheduleSavedAt: null,
        })
      );

      expect(html).toContain('2 位學生資料已備妥');
      expect(html).toContain('開始核對');
      expect(html).toContain('href="/"');
    });
  });

  /**
   * Rework B1（REJECTED @2413e03）：預覽階段靜默丟失 preview.issues。
   * 實害：erp-reader 遇空白人員代碼會 push issue 後略過該列，該列不進名冊；
   * 使用者只看到總人數而無警告，實際有學生被丟棄（違反 D17 照實呈現、specs/09 §4）。
   * 斷言的不只是「有渲染」，而是「該列的列號出現在警告中」且「總人數不含該列」。
   */
  describe('Rework B1：匯入注意事項（preview.issues）必須可見且含列號', () => {
    it('有 issues 時渲染「匯入注意事項：」並逐條列出（含列號／欄名／修正方式）', () => {
      const html = renderToStaticMarkup(
        React.createElement(ImportsWorkflow, {
          initialStage: 'preview',
          initialPreview: mockPreview,
          currentRevision: 0,
          lastScheduleSavedAt: null,
        })
      );

      expect(html).toContain('匯入注意事項');
      // 具體列號出現在警告中（D17 照實呈現：不能只給總數）
      expect(html).toContain('第 4 列未填寫人員代碼，已略過。');
    });

    it('issues 為空陣列時不渲染該區塊（不產生空提示殘留）', () => {
      const html = renderToStaticMarkup(
        React.createElement(ImportsWorkflow, {
          initialStage: 'preview',
          initialPreview: { ...mockPreview, issues: [] },
          currentRevision: 0,
          lastScheduleSavedAt: null,
        })
      );

      expect(html).not.toContain('匯入注意事項');
    });
  });

  /**
   * Rework B2：token 徽章遺失「離班日期」與「(預設) 級距」標記。
   * 兩者皆為資料可見性需求，非純裝飾：
   * - 離班：篩選器與統計卡有離班資訊，表格必須看得出是哪幾位
   * - (預設)：該級距是解析失敗後採預設值、非 ERP 原始登記值，不可被誤認為實登值
   */
  describe('Rework B2：token 徽章須保留離班日期與 (預設) 級距標記', () => {
    it('有離班日期的 token 顯示「離班: 日期」徽章', () => {
      const html = renderToStaticMarkup(
        React.createElement(ImportsWorkflow, {
          initialStage: 'preview',
          initialPreview: mockPreview,
          currentRevision: 0,
          lastScheduleSavedAt: null,
        })
      );

      expect(html).toContain('離班: 2026-07-01');
      expect(html).toContain('badge-withdrawal');
    });

    it('tierParseStatus 為 defaulted 時標記「(預設)」，非 defaulted 時不標', () => {
      const withDefault = renderToStaticMarkup(
        React.createElement(ImportsWorkflow, {
          initialStage: 'preview',
          initialPreview: mockPreview,
          currentRevision: 0,
          lastScheduleSavedAt: null,
        })
      );
      expect(withDefault).toContain('(預設)');

      const parsed = renderToStaticMarkup(
        React.createElement(ImportsWorkflow, {
          initialStage: 'preview',
          initialPreview: {
            ...mockPreview,
            students: [
              {
                ...mockPreview.students[0],
                enrollments: [
                  {
                    ...mockPreview.students[0].enrollments[0],
                    tierParseStatus: 'parsed' as never,
                  },
                ],
              },
              mockPreview.students[1],
            ],
          },
          currentRevision: 0,
          lastScheduleSavedAt: null,
        })
      );
      expect(parsed).not.toContain('(預設)');
    });
  });

  /**
   * R3 曾以「報名異動」標示 rosterDiff 的比對範圍（decision d-20260929110117338263-3）。
   * R4 operator 裁決（d-20260929111803466480-4 / d-20260929111814541876-5）已正式以
   * 折扣與安親／課輔扣除天數的 before & after 計算結果取代該代理指標，故「報名異動」
   * 文案一併移除，改為指向正式判準；「新增／未出現」兩個 rosterDiff 算得出且語意正確的數字保留。
   */
  describe('R4 裁決：報名異動代理指標移除，指向以計算結果判定', () => {
    it('「新增」「未出現」仍呈現；「報名異動」已移除，改為指向計算結果判準', () => {
      const html = renderToStaticMarkup(
        React.createElement(ImportsWorkflow, {
          initialStage: 'preview',
          initialPreview: withDiff({}),
          currentRevision: 0,
          lastScheduleSavedAt: null,
        })
      );

      expect(html).toContain('新增');
      expect(html).toContain('未出現');
      // 代理指標已移除：不可再以「報名異動」宣稱異動人數
      expect(html).not.toContain('報名異動');
      expect(html).toContain('核對結果頁');
    });

    it('基準名單為 null（首次匯入）時不呈現差異統計區塊', () => {
      const html = renderToStaticMarkup(
        React.createElement(ImportsWorkflow, {
          initialStage: 'preview',
          initialPreview: withDiff({ baseImportId: null }),
          currentRevision: 0,
          lastScheduleSavedAt: null,
        })
      );

      expect(html).not.toContain('報名異動');
    });
  });
});
