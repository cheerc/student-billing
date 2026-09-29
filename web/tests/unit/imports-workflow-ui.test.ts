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
    const mockPreview: ImportPreviewResult = {
      previewId: 'imp_mock_123',
      fileName: 'student-list.xlsx',
      fileHash: 'filehash123',
      contentHash: 'contenthash123',
      sheetName: 'Sheet1',
      candidateSheets: ['Sheet1'],
      headerRowIndex: 1,
      stats: {
        totalStudents: 477,
        studentsWithClass: 384,
        studentsWithoutClass: 93,
        withdrawnStudentsCount: 10,
        gradeCounts: { '1': 1 },
      },
      headerMapping: {},
      extraHeaders: [],
      pendingClasses: ['未定義班級甲'],
      issues: [],
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
          enrollments: [],
          sourceRow: 2,
        },
      ],
      scopeNote: '測試批次',
    };

    it('預覽階段顯示名冊統計、核對基準日與主按鈕「使用這份名單」', () => {
      const html = renderToStaticMarkup(
        React.createElement(ImportsWorkflow, {
          initialStage: 'preview',
          initialPreview: mockPreview,
          currentRevision: 0,
          lastScheduleSavedAt: '2026-09-29T10:00:00.000Z',
        })
      );

      // 人數統計
      expect(html).toContain('477');
      expect(html).toContain('384');
      expect(html).toContain('93');

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
          activatedCount: 477,
          currentRevision: 1,
          lastScheduleSavedAt: null,
        })
      );

      expect(html).toContain('477 位學生資料已備妥');
      expect(html).toContain('開始核對');
      expect(html).toContain('href="/"');
    });
  });
});
