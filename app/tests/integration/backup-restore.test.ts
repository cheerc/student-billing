import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport } from '@/application/activate-import';
import { queryRunStudents } from '@/application/query-students';
import { backupData, restoreData, verifyDataIntegrity } from '../../scripts/backup-restore';

describe('T06: 停機備份與災難還原實測 (I12, specs/07 §6)', () => {
  let sourceDir: string;
  let backupDir: string;
  let restoreDir: string;
  let originalRunId: string;

  beforeEach(async () => {
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-source-data-'));
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-backup-data-'));
    restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-restore-data-'));

    // 在 sourceDir 建立完整活資料庫並啟用
    const dbPath = path.join(sourceDir, 'app.sqlite');
    const db = createDatabase(dbPath);
    runMigrations(db);

    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    const buf = fs.readFileSync(fixturePath);
    const preview = await generateImportPreview(buf, 'fixture.xlsx');

    saveImportBatch(
      db,
      {
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
        createdAt: new Date().toISOString(),
      },
      preview.students
    );

    const actRes = activateImport(db, {
      importId: preview.previewId,
      expectedRevision: 0,
      idempotencyKey: 'backup-restore-test-key',
    });
    originalRunId = actRes.runId;

    db.close();
  });

  afterEach(() => {
    for (const d of [sourceDir, backupDir, restoreDir]) {
      if (fs.existsSync(d)) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it('1. 停機備份應產出完整備份檔與 backup-manifest.json，指標完全一致', () => {
    const manifest = backupData(sourceDir, backupDir);

    expect(manifest.version).toBe('1.0');
    expect(manifest.activeState.revision).toBe(1);
    expect(manifest.activeState.activeRunId).toBe(originalRunId);
    expect(manifest.stats.totalStudents).toBe(477);
    expect(manifest.stats.totalRuns).toBe(1);

    expect(fs.existsSync(path.join(backupDir, 'app.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'backup-manifest.json'))).toBe(true);
  });

  it('2. 災難還原至非空目錄時，若無 force 旗標應拒絕並拋錯，防範無提示覆蓋原資料', () => {
    backupData(sourceDir, backupDir);

    // 在目標目錄放置已有檔案
    fs.writeFileSync(path.join(restoreDir, 'existing_file.txt'), 'do-not-overwrite');

    expect(() => {
      restoreData(backupDir, restoreDir, { force: false });
    }).toThrowError(/為防範無提示覆蓋原資料，禁止直接還原/);
  });

  it('3. 還原至空目錄後驗證一致性，資料庫完整性 ok，筆數、activeRun 與代表查詢分毫不差', () => {
    backupData(sourceDir, backupDir);

    // 清空目標目錄
    fs.rmSync(restoreDir, { recursive: true, force: true });
    fs.mkdirSync(restoreDir);

    const verify = restoreData(backupDir, restoreDir);

    expect(verify.ok).toBe(true);
    expect(verify.integrity).toBe('ok');
    expect(verify.revision).toBe(1);
    expect(verify.activeRunId).toBe(originalRunId);
    expect(verify.totalStudents).toBe(477);
    expect(verify.mismatchCount).toBe(5);

    // 以新資料庫連線執行代表性查詢
    const restoredDb = createDatabase(path.join(restoreDir, 'app.sqlite'));
    const studentsRes = queryRunStudents(restoredDb, originalRunId, { tierMismatch: true });
    expect(studentsRes.totalStudents).toBe(5);
    const sourceRows = studentsRes.items.map((s) => s.sourceRow).sort((a, b) => a - b);
    expect(sourceRows).toEqual([30, 35, 43, 51, 52]);

    restoredDb.close();
  });
});
