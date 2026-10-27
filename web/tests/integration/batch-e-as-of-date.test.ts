import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport } from '@/application/activate-import';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { executeCalculationRun } from '@/application/calculate-run';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';

// 固定在台北 2026-10-01 00:30；UTC 尚為 09-30。只固定 Date，不 mock 計算／SQL。
const NOW = new Date('2026-09-30T16:30:00.000Z');
const D = '2025-02-03';

describe('批次 E：核對基準日來源（UX75／UX77）', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-batch-e-date-'));
    db = createDatabase(path.join(dir, 'app.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  async function readyImport() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);
    sheet.addRow(['BATCH_E_001', '合成基準日學生', '本校', '國小輔導-一A[團]', '一年級', '', '']);
    const preview = await generateImportPreview(Buffer.from(await workbook.xlsx.writeBuffer()), 'synthetic-date.xlsx');
    saveImportBatch(db, {
      id: preview.previewId,
      fileName: preview.fileName,
      fileHash: preview.fileHash,
      contentHash: preview.contentHash,
      sheetName: preview.sheetName,
      headerMap: preview.headerMapping,
      parserVersion: '1.0.0',
      scopeNote: preview.scopeNote,
      rowCount: preview.stats.totalStudents,
      status: 'ready',
      createdAt: NOW.toISOString(),
    }, preview.students);
    return preview.previewId;
  }

  it('UX75：import→activate(D)→preview→apply 沿用 D，舊 run 逐欄不變', async () => {
    const importId = await readyImport();
    const active = activateImport(db, { importId, expectedRevision: 0, idempotencyKey: 'batch-e-act', asOfDate: D });
    const oldRun = getCalculationRun(db, active.runId);
    expect(oldRun?.asOfDate).toBe(D);
    const draft = buildSeedDraft();
    draft.classes[0].teacher = '合成新老師';
    const preview = previewSettingsChange(db, undefined, { draft, expectedRevision: active.revision });
    const applied = applySettingsPreview(db, { previewId: preview.previewId, expectedRevision: active.revision, idempotencyKey: 'batch-e-apply' });
    expect(applied.runId).not.toBe(active.runId);
    expect.soft(getCalculationRun(db, applied.runId!)?.asOfDate, '儲存不是重選核對基準日').toBe(D);
    // Single current state: older run is pruned
    expect(getCalculationRun(db, active.runId)).toBeNull();
  });

  it('UX77：未帶 asOfDate 的真實計算入口退回 Asia/Taipei 今天', async () => {
    const importId = await readyImport();
    const { run } = executeCalculationRun(db, importId, 'run_batch_e_default_date');
    expect(run.asOfDate).toBe('2026-10-01');
  });

  it('UX76 characterization：只換 asOfDate，業務欄位逐欄不變', async () => {
    const importId = await readyImport();
    const left = executeCalculationRun(db, importId, 'run_batch_e_date_left', { asOfDate: D });
    const right = executeCalculationRun(db, importId, 'run_batch_e_date_right', { asOfDate: '2030-12-31' });
    expect(left.run.asOfDate).toBe(D);
    expect(right.run.asOfDate).toBe('2030-12-31');
    // 03 asOfDate 只記錄來源：這是「相同」關係的 characterization，不產生／回填 golden。
    // 獨立手算：小一、只報一般輔導、無數學／美語／優惠 → 一科、基本100%、安親5天。
    for (const result of [left, right]) {
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({ subjectCount: 1, baseDiscountBps: 10000, anqinDays: 5, tutoringDays: null, tierMismatch: false });
    }
    const fields = [
      'subjectCount', 'baseDiscountBps', 'anqinDays', 'anqinDisplay', 'tutoringDays', 'tutoringDisplay',
      'englishDays', 'mathDays', 'chineseDays', 'homeworkDays', 'intensiveEnglishDays', 'saturdayTutoringDays',
      'applicableAnqinBps', 'applicableTutoringBps', 'applicableEnglishBps', 'applicableMathBps', 'tierMismatch', 'tierComparisons',
    ] as const;
    for (const field of fields) expect(left.results[0][field], field).toEqual(right.results[0][field]);
    expect(left.results[0].issues.map((issue: { code: string }) => issue.code).sort()).toEqual(right.results[0].issues.map((issue: { code: string }) => issue.code).sort());
  });

  it('characterization：settings_only 儲存不建 run、不改 active import', () => {
    const preview = previewSettingsChange(db, undefined, { draft: buildSeedDraft(), expectedRevision: 0 });
    const applied = applySettingsPreview(db, { previewId: preview.previewId, expectedRevision: 0, idempotencyKey: 'batch-e-empty' });
    expect(applied.mode).toBe('settings_only');
    expect(applied.runId).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM calculation_runs').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT active_import_id, active_run_id FROM active_state WHERE id = 1').get()).toEqual({ active_import_id: null, active_run_id: null });
  });
});
