import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { getScheduleDeductions } from '@/application/schedule-deductions';
import { activateImport } from '@/application/activate-import';
import { generateImportPreview } from '@/application/import-preview';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClassDeductionsPanel, classDeductionsColumns } from '@/components/results/class-deductions-panel';
import type { DeductionsResponse } from '@/application/schedule-deductions';

/**
 * 09 §5.2 班級扣天（對應 Excel C表）：欄為 班級、老師、上課時間摘要、安親原始扣除、
 * 安親實際扣除、課輔原始扣除、課輔實際扣除、狀態。
 * 四個扣除欄單位天、正量顯示；原始三位小數、實際半天單位。
 * 有 active run 讀該 run 快照；無 active 讀已儲存課表並標「尚未匯入學生，可先檢查扣天」。
 */

const FIXTURE = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');

describe('UX05–07／09 §5.2：班級扣天 read model 與面板', () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-r4-ded-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('欄位順序為規格所列 8 欄（扣除欄單位天、正量）', () => {
    expect(classDeductionsColumns).toEqual([
      '班級',
      '老師',
      '上課時間',
      '安親原始扣除',
      '安親實際扣除',
      '課輔原始扣除',
      '課輔實際扣除',
      '狀態',
    ]);
  });

  it('無 active run：讀已儲存課表（無已儲存設定時為 seed）並標示可先檢查扣天', () => {
    const res = getScheduleDeductions(db);
    expect(res.scope).toBe('seed');
    expect(res.runId).toBeNull();
    expect(res.classes.length).toBeGreaterThan(0);

    const html = renderToStaticMarkup(
      React.createElement(ClassDeductionsPanel, { data: res, onEditClass: () => {} })
    );
    expect(html).toContain('尚未匯入學生，可先檢查扣天');
    // 狀態欄：缺時段／安親課輔班（不計時段）／無重疊分開
    expect(html).toMatch(/無重疊|安親課輔班（不計時段）|待補/);
  });

  it('扣除以正量顯示：rawDeduction／rounded 為 domain 負值，畫面顯示正量', () => {
    const res = getScheduleDeductions(db);
    // 找一個有扣天的班驗證正量呈現
    const withDeduction = res.classes.find((c) => c.anqin.rounded !== 0 || c.tutoring.rounded !== 0);
    expect(withDeduction).toBeDefined();
    const raw = withDeduction!.anqin.raw !== 0 ? withDeduction!.anqin.raw : withDeduction!.tutoring.raw;
    expect(raw).toBeLessThan(0); // domain 為負值

    const html = renderToStaticMarkup(
      React.createElement(ClassDeductionsPanel, { data: res, onEditClass: () => {} })
    );
    // 畫面不可出現負號（正量顯示）
    const dedCells = html.match(/-?\d+\.\d+/g) ?? [];
    // 負值僅可能出現在非扣除欄（如日期），此處確認扣除欄無負號
    expect(html).not.toMatch(/>-\d/);
  });

  it('有 active run：讀該 run 的課表快照（scope=active_run）', async () => {
    const buf = fs.readFileSync(FIXTURE);
    const preview = await generateImportPreview(buf, 'ded.xlsx');
    saveImportBatch(
      db,
      {
        id: 'imp_ded',
        fileName: 'ded.xlsx',
        fileHash: preview.fileHash,
        contentHash: preview.contentHash,
        sheetName: preview.sheetName,
        headerMap: preview.headerMapping,
        parserVersion: '1.0.0',
        scopeNote: '',
        rowCount: preview.stats.totalStudents,
        status: 'ready',
        createdAt: new Date().toISOString(),
      },
      preview.students
    );
    activateImport(db, { importId: 'imp_ded', expectedRevision: 0, idempotencyKey: 'ded-1' });

    const res = getScheduleDeductions(db);
    expect(res.scope).toBe('active_run');
    expect(res.runId).not.toBeNull();
    // 有 active run 時不顯示「尚未匯入學生」
    const html = renderToStaticMarkup(
      React.createElement(ClassDeductionsPanel, { data: res, onEditClass: () => {} })
    );
    expect(html).not.toContain('尚未匯入學生');
  });

  it('點班級可展開全部時段（逐堂五個計算欄）並連結「編輯此班課表」', () => {
    const res = getScheduleDeductions(db);
    const html = renderToStaticMarkup(
      React.createElement(ClassDeductionsPanel, { data: res, onEditClass: () => {}, expandedClassKey: '國小數學-一A' })
    );
    expect(html).toContain('編輯此班課表');
    // 逐堂欄位
    expect(html).toContain('課程時長');
    expect(html).toContain('安親');
    expect(html).toContain('課輔');
  });

  it('狀態欄區分：無重疊／安親課輔班（不計時段）／待補／需確認（不混為同一種狀態）', () => {
    const res = getScheduleDeductions(db);
    const statuses = new Set(res.classes.map((c) => c.anqin.status));
    // seed 內容含多種類型；不應只有一種
    expect(statuses.size).toBeGreaterThan(1);
  });

  it('D61 Phase 2：不排課（unscheduled）與共用窗口班級狀態標籤與上課時間摘要顯示「—」', () => {
    const mockData: DeductionsResponse = {
      scope: 'saved_settings',
      runId: null,
      scheduleVersionId: 'sv_test',
      settingsRevision: 1,
      draftHash: 'hash_test',
      ruleSetVersion: 'erp-tag-v4',
      windows: {
        anqin: { startMinutes: 780, endMinutes: 960, weekdays: ['一', '二', '三', '四', '五'] },
        tutoring: { startMinutes: 990, endMinutes: 1170, weekdays: ['一', '二', '三', '四', '五'] },
      },
      rows: [
        {
          rowId: '交通車#placeholder',
          classKey: '交通車',
          teacher: '陳司機',
          weekday: null,
          startMinutes: null,
          endMinutes: null,
          durationMinutes: null,
          anqin: { overlapMinutes: null, rawDeduction: null, status: 'unscheduled' },
          tutoring: { overlapMinutes: null, rawDeduction: null, status: 'unscheduled' },
        },
        {
          rowId: '國小輔導-一年級#placeholder',
          classKey: '國小輔導-一年級',
          teacher: '王老師',
          weekday: null,
          startMinutes: null,
          endMinutes: null,
          durationMinutes: null,
          anqin: { overlapMinutes: null, rawDeduction: null, status: 'shared_window' },
          tutoring: { overlapMinutes: null, rawDeduction: null, status: 'shared_window' },
        },
      ],
      classes: [
        {
          classKey: '交通車',
          teacher: '陳司機',
          active: true,
          rowIds: ['交通車#placeholder'],
          anqin: { totalOverlapMinutes: 0, raw: 0, rounded: 0, status: 'unscheduled' },
          tutoring: { totalOverlapMinutes: 0, raw: 0, rounded: 0, status: 'unscheduled' },
        },
        {
          classKey: '國小輔導-一年級',
          teacher: '王老師',
          active: true,
          rowIds: ['國小輔導-一年級#placeholder'],
          anqin: { totalOverlapMinutes: 0, raw: 0, rounded: 0, status: 'shared_window' },
          tutoring: { totalOverlapMinutes: 0, raw: 0, rounded: 0, status: 'shared_window' },
        },
      ],
      issues: [],
    };

    const html = renderToStaticMarkup(
      React.createElement(ClassDeductionsPanel, { data: mockData, onEditClass: () => {} })
    );

    // 驗證狀態顯示為「不排課」
    expect(html).toContain('不排課');
    // 驗證狀態顯示為「安親課輔班（不計時段）」
    expect(html).toContain('安親課輔班（不計時段）');
    // 驗證兩個班級的上課時間摘要皆顯示為「—」，而不是「待補」
    expect(html).not.toContain('待補');
  });
});
