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

/** 差異統計：基準名單存在時 UI 應呈現新增／異動／未出現，並附逐人明細（B1）。 */
const side = (over: Record<string, unknown> = {}) => ({
  subjectCount: 2,
  baseDiscountBps: 9500,
  applicableAnqinBps: 9500,
  applicableTutoringBps: 9500,
  anqinDays: 5,
  tutoringDays: 5,
  isEnrolledAnqin: false,
  isEnrolledTutoring: true,
  ...over,
});

const mockChanges = [
  {
    // 異動：折扣 95折→9折、課輔天數 5→4（含退掉／新報的逐班明細）
    personCode: 'CHG001',
    name: '異動同學',
    isNew: false,
    isRemoved: false,
    before: side(),
    after: side({ subjectCount: 3, baseDiscountBps: 9000, tutoringDays: 4 }),
    discountChange: {
      beforeBps: 9500,
      afterBps: 9000,
      beforeLabel: '95折',
      afterLabel: '9折',
      reason: '已補科數變動',
    },
    dayChange: {
      beforeAnqinDays: 5,
      afterAnqinDays: 5,
      beforeTutoringDays: 5,
      afterTutoringDays: 4,
      classBreakdown: [
        {
          baseName: '國小數學-一A',
          rawToken: '國小數學-一A[團]',
          presence: 'removed',
          beforeAnqinDeduction: 0.5,
          beforeTutoringDeduction: 0,
          afterAnqinDeduction: null,
          afterTutoringDeduction: null,
          statusBefore: 'calculated',
          statusAfter: 'not_enrolled',
        },
        {
          baseName: '國小數學-三A',
          rawToken: '國小數學-三A[團]',
          presence: 'added',
          beforeAnqinDeduction: null,
          beforeTutoringDeduction: null,
          afterAnqinDeduction: 0,
          afterTutoringDeduction: 1,
          statusBefore: 'not_enrolled',
          statusAfter: 'calculated',
        },
      ],
    },
    reasons: ['已補科數變動', '安親／課輔扣除天數變動'],
  },
  {
    personCode: 'NEW001',
    name: '新增同學',
    isNew: true,
    isRemoved: false,
    before: null,
    after: side(),
    discountChange: null,
    dayChange: null,
    reasons: ['新增學生'],
  },
  {
    personCode: 'GONE001',
    name: '未出現同學',
    isNew: false,
    isRemoved: true,
    before: side(),
    after: null,
    discountChange: null,
    dayChange: null,
    reasons: ['本次名單未出現'],
  },
];

const withDiff = (over: Record<string, unknown>) => ({
  ...mockPreview,
  rosterDiff: {
    baseImportId: 'imp_base',
    newStudents: 1,
    changedStudents: 2,
    unchangedStudents: 0,
    notAppearedStudents: 3,
    changes: mockChanges,
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
   * R4 operator 裁決（d-20260929111803466480-4 / d-20260929111814541876-5）：「異動」是匯入預覽的
   * 折扣與安親／課輔扣除天數 before & after 計算結果；Reviewer B1（PR #32）指出該功能只寫成函式、
   * 沒有接到畫面。本區塊從 UI 驗證三個數字與逐人明細真的顯示，且沒有留下未兌現的承諾文案。
   */
  describe('R4 裁決＋B1：預覽顯示新增／異動／未出現三個數字與逐人明細', () => {
    const render = (preview: unknown) =>
      renderToStaticMarkup(
        React.createElement(ImportsWorkflow, {
          initialStage: 'preview',
          initialPreview: preview as any,
          currentRevision: 0,
          lastScheduleSavedAt: null,
        })
      );

    it('三個數字都顯示（新增／異動／未出現），數字取自 API 而非畫面自算', () => {
      const html = render(withDiff({ newStudents: 7, changedStudents: 11, notAppearedStudents: 13 }));

      expect(html).toMatch(/data-diff="new"[^>]*>新增 <strong>7<\/strong> 人/);
      expect(html).toMatch(/data-diff="changed"[^>]*>異動 <strong>11<\/strong> 人/);
      expect(html).toMatch(/data-diff="not-appeared"[^>]*>未出現 <strong>13<\/strong> 人/);
    });

    it('沒有未兌現的承諾：不再出現「將於核對結果頁逐位列出」，也不出現「報名異動」代理指標', () => {
      const html = render(withDiff({}));

      expect(html).not.toContain('核對結果頁');
      expect(html).not.toContain('逐位列出');
      expect(html).not.toContain('報名異動');
    });

    it('逐人明細：異動者顯示折扣與天數 before → after，並標明退掉／新報的課', () => {
      const html = render(withDiff({}));

      // 明細容器與人員
      expect(html).toContain('roster-changes-details');
      expect(html).toContain('異動同學');
      expect(html).toContain('CHG001');
      // 折扣 95折 → 9折（B1：使用者看得到 operator 裁決要的對照）
      expect(html).toContain('95折');
      expect(html).toContain('9折');
      // 課輔天數 5 → 4（以 data-field 標記欄位，避免以文字順序猜測）
      expect(html).toMatch(/data-field="tutoring-days"[^>]*>5 → 4</);
      expect(html).toMatch(/data-field="discount"[^>]*>95折 → 9折</);
      // 逐班明細（B2）：退掉的課與新報的課都要列出，並附各自的扣天數
      expect(html).toContain('國小數學-一A');
      expect(html).toContain('退掉');
      expect(html).toContain('國小數學-三A');
      expect(html).toContain('新報');
    });

    it('新增與未出現的學生也在明細中，可對照計數', () => {
      const html = render(withDiff({}));

      expect(html).toContain('新增同學');
      expect(html).toContain('未出現同學');
      expect(html).toContain('NEW001');
      expect(html).toContain('GONE001');
    });

    it('沒有任何異動明細時不出現明細區塊（但三個數字仍顯示）', () => {
      const html = render(withDiff({ newStudents: 0, changedStudents: 0, notAppearedStudents: 0, changes: [] }));

      expect(html).toContain('與目前名單相比');
      expect(html).not.toContain('roster-changes-details');
    });

    it('基準名單為 null（首次匯入）時不呈現差異統計區塊', () => {
      const html = render(withDiff({ baseImportId: null, changes: [] }));

      expect(html).not.toContain('與目前名單相比');
      expect(html).not.toContain('roster-changes-details');
      expect(html).not.toContain('報名異動');
    });
  });
});
