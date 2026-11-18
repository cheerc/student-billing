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
import { ClassDeductionsPanel, classDeductionsColumns, classDeductionColumnDefs, deductionFilterSection } from '@/components/results/class-deductions-panel';
import { sortRows } from '@/components/tables/use-client-sort';
import { BLANK } from '@/lib/results-filters';
import type { Cell } from '@/lib/table-columns/cell';
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


/**
 * UX133 (b)（D66）：班級扣天的排序與表頭篩選選項來自共用欄位模組。
 * 老師 `吳一`（總筆畫 7）、`王一`（4）、空白：升冪 王一、吳一、空白（碼點序會是 吳一、王一）；
 * 選項 王一、吳一、(空白)（空白最後）。expected 手算寫死，不由 Collator 或待測函式產生。
 */
describe('UX133 (b)：班級扣天共用欄位模組', () => {
  type DC = DeductionsResponse['classes'][number];
  const side = (raw: number | null, rounded: number | null, status: DC['anqin']['status'] = 'calculated') =>
    ({ totalOverlapMinutes: 0, raw, rounded, status }) as DC['anqin'];
  const cls = (classKey: string, teacher: string | null, anqin: DC['anqin'], tutoring: DC['tutoring'] = side(0, 0, 'no_overlap')): DC =>
    ({ classKey, teacher, active: true, rowIds: [], anqin, tutoring }) as DC;
  const classes = [
    cls('班乙', '吳一', side(-0.5, -0.5)),
    cls('班甲', null, side(-1.25, -1)),
    cls('班丙', '王一', side(null, null, 'unscheduled'), side(null, null, 'unscheduled')),
    cls('班丁', '吳一', side(-0.5, 0)),
  ];
  const col = (key: string) => classDeductionColumnDefs.find((c) => c.key === key)!;
  const keys = (rows: DC[]) => rows.map((c) => c.classKey);
  const sortBy = (key: string, dir: 'ascending' | 'descending') => keys(sortRows(classes, col(key).sort as { cell: (c: DC) => Cell }, dir));

  it('老師升冪 王一、吳一（輸入序 班乙、班丁）、空白；降冪 吳一（班乙、班丁）、王一、空白', () => {
    expect(sortBy('teacher', 'ascending')).toEqual(['班丙', '班乙', '班丁', '班甲']);
    expect(sortBy('teacher', 'descending')).toEqual(['班乙', '班丁', '班丙', '班甲']);
  });

  it('老師篩選選項 王一、吳一、(空白)；wire 值 王一／吳一／~blank，count 依班級去重', () => {
    const section = deductionFilterSection(classes, 'dTeacher');
    expect(section.key).toBe('dTeacher');
    expect(section.options).toEqual([
      { value: '王一', label: '王一' },
      { value: '吳一', label: '吳一' },
      { value: BLANK, label: '(空白)' },
    ]);
  });

  it('狀態選項依筆畫：已計算（已 3 畫）在不排課（不 4 畫）前', () => {
    expect(deductionFilterSection(classes, 'dStatus').options.map((o) => o.label)).toEqual(['已計算', '不排課']);
  });

  it('四個扣除欄：底層值＝正量數值、顯示文字＝formatDeduction；null＝空白（排最後，不當 0）', () => {
    const raw = col('anqinRaw').sort as { cell: (c: DC) => Cell };
    const actual = col('anqinActual').sort as { cell: (c: DC) => Cell };
    expect(raw.cell(classes[1]!)).toEqual({ value: 1.25, text: '1.250' });
    expect(actual.cell(classes[1]!)).toEqual({ value: 1, text: '1' });
    expect(actual.cell(classes[3]!)).toEqual({ value: 0, text: '0' });
    expect(raw.cell(classes[2]!)).toBeNull();
    expect(sortBy('anqinRaw', 'ascending')).toEqual(['班乙', '班丁', '班甲', '班丙']);
    expect(sortBy('anqinRaw', 'descending')).toEqual(['班甲', '班乙', '班丁', '班丙']);
  });
});
