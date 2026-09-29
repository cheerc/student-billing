import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ExcelJS from 'exceljs';
import { readErpWorkbook } from '@/adapters/xlsx/erp-reader';
import { generateImportPreview } from '@/application/import-preview';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { ImportsWorkflow } from '@/components/imports/imports-workflow';

/**
 * Rework B1 的實質斷言（PR #31 REJECTED @2413e03）：
 * 不只斷言「issues 有被渲染」，而是以真實 erp-reader 產生的 issues 串到 UI 渲染，
 * 證明被略過的資料列在畫面上真的看得見，且總人數確實不含該列。
 *
 * fixture：4 列有值資料（3 列有效 + 1 列人員代碼空白，標頭在第 1 列，空白列落在第 5 列）。
 * erp-reader 對空白人員代碼 `issues.push('第 5 列未填寫人員代碼，已略過。')` 後 `continue`，
 * 該列不進名冊 → 總人數 3。
 */

describe('Rework B1 實質斷言：被略過的資料列在 UI 看得見（真實 erp-reader → UI）', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-issues-fixture-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    const db = createDatabase(path.join(tempDir, 'test.sqlite'));
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

  /** 建立含空白人員代碼列的最小試算表：3 列有效 + 第 4 列（工作表列號 5）代碼空白。 */
  async function workbookWithBlankPersonCode() {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['人員代碼', '姓名', '所屬分校', '年級', '所屬班級', '標籤', '備註']);
    ws.addRow(['STU001', '王小明', '本校', '一年級', '數學一[團]', '', '']);
    ws.addRow(['STU002', '李小華', '本校', '二年級', '數學二[團]', '', '']);
    ws.addRow(['STU003', '陳小美', '本校', '三年級', '', '', '']);
    // 第 5 列（工作表列號，含標頭）：人員代碼刻意留白 → erp-reader 略過並記 issue
    ws.addRow(['', '周小龍', '本校', '四年級', '數學四[團]', '', '']);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('真實 reader 產生 issue 且該列不進名冊；UI 顯示該列號與原因、總人數不含該列', async () => {
    const buf = await workbookWithBlankPersonCode();
    const preview = await generateImportPreview(buf, 'with-blank-person-code.xlsx');

    // 前置：reader 層的實質行為——4 列有值但只有 3 位學生，issue 記錄被略過的第 5 列
    expect(preview.students).toHaveLength(3);
    expect(preview.stats.totalStudents).toBe(3);
    expect(preview.issues).toContain('第 5 列未填寫人員代碼，已略過。');
    expect(preview.students.map((s) => s.personCode)).not.toContain('周小龍');

    // UI 層：該 issue 的列號與原因必須在畫面上可見
    const html = renderToStaticMarkup(
      React.createElement(ImportsWorkflow, {
        initialStage: 'preview',
        initialPreview: preview,
        currentRevision: 0,
        lastScheduleSavedAt: null,
      })
    );

    expect(html).toContain('匯入注意事項');
    expect(html).toContain('第 5 列未填寫人員代碼，已略過。');

    // 被略過的學生確實不在畫面的名單中
    expect(html).not.toContain('周小龍');
  });

  it('issues 為空時（所有列皆有效）不渲染「匯入注意事項」區塊', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['人員代碼', '姓名', '所屬分校', '年級', '所屬班級', '標籤', '備註']);
    ws.addRow(['STU001', '王小明', '本校', '一年級', '數學一[團]', '', '']);
    ws.addRow(['STU002', '李小華', '本校', '二年級', '數學二[團]', '', '']);

    const preview = await generateImportPreview(
      Buffer.from(await wb.xlsx.writeBuffer()),
      'all-valid.xlsx'
    );
    expect(preview.issues).toEqual([]);

    const html = renderToStaticMarkup(
      React.createElement(ImportsWorkflow, {
        initialStage: 'preview',
        initialPreview: preview,
        currentRevision: 0,
        lastScheduleSavedAt: null,
      })
    );

    expect(html).not.toContain('匯入注意事項');
  });
});
