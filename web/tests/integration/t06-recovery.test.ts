import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NextRequest } from 'next/server';
import ExcelJS from 'exceljs';
import { createDatabase, getDefaultDatabasePath } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch, getImportBatch } from '@/adapters/sqlite/import-repository';
import { getCurrentActiveRun, getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport, ActivateConflictError, ActivateError } from '@/application/activate-import';
import { queryRunStudents, QueryStudentError } from '@/application/query-students';
import { readErpWorkbook, ErpReaderError } from '@/adapters/xlsx/erp-reader';
import { validateSameOrigin, sanitizePathParam } from '@/contracts/security';

describe('T06: 故障恢復、邊界防護與安全性整合測試 (I09-I14)', () => {
  let tempDir: string;
  let tempDbPath: string;
  let db: any;
  let previewId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-t06-test-'));
    tempDbPath = path.join(tempDir, 'test.sqlite');
    process.env.DATABASE_PATH = tempDbPath;

    db = createDatabase(tempDbPath);
    runMigrations(db);

    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    const buf = fs.readFileSync(fixturePath);
    const preview = await generateImportPreview(buf, 'fixture.xlsx');
    previewId = preview.previewId;

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
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch (_e) {}
    }
    delete process.env.DATABASE_PATH;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------
  // I09: 中途故障 activeRun 與舊資料完全不變
  // -------------------------------------------------------------
  it('I09: 計算或 DB 寫入中途故障時，activeRun 與舊資料完全不變（原子性保證）', () => {
    // 先成功啟用一次，確立 baseline (revision 1)
    const initialAct = activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: 't06-act-initial',
    });
    expect(initialAct.revision).toBe(1);

    const beforeState = getCurrentActiveRun(db);
    expect(beforeState.revision).toBe(1);
    expect(beforeState.activeRunId).toBe(initialAct.runId);

    // 模擬中途故障：傳入不存在的 importId 執行 activate，預期拋出例外
    expect(() => {
      activateImport(db, {
        importId: 'non-existent-import-id',
        expectedRevision: 1,
        idempotencyKey: 't06-act-fail',
      });
    }).toThrow();

    // 驗證 active_state 與原有 run 結果毫髮無傷
    const afterState = getCurrentActiveRun(db);
    expect(afterState.revision).toBe(1);
    expect(afterState.activeRunId).toBe(initialAct.runId);
    expect(afterState.activeImportId).toBe(previewId);

    const run = getCalculationRun(db, initialAct.runId);
    expect(run).not.toBeNull();
    expect(run?.totalStudents).toBe(477);
  });

  // -------------------------------------------------------------
  // I12: 關閉重開保留
  // -------------------------------------------------------------
  it('I12: 關閉資料庫連線並重新開啟，學生、設定、run 與 active pointer 完整保留', () => {
    // 啟用正式 run
    const actRes = activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: 't06-i12-key',
    });

    const runIdBefore = actRes.runId;
    const revBefore = actRes.revision;

    // 關閉 DB 連線（模擬應用程式停機關閉）
    db.close();

    // 重新建立連線（模擬應用程式重啟）
    const reopenedDb = createDatabase(tempDbPath);
    runMigrations(reopenedDb);

    // 驗證 active state
    const active = getCurrentActiveRun(reopenedDb);
    expect(active.revision).toBe(revBefore);
    expect(active.activeRunId).toBe(runIdBefore);
    expect(active.activeImportId).toBe(previewId);

    // 驗證批次與學生資料
    const batch = getImportBatch(reopenedDb, previewId);
    expect(batch).not.toBeNull();
    expect(batch?.rowCount).toBe(477);

    // 驗證查詢計算結果
    const queryRes = queryRunStudents(reopenedDb, runIdBefore, { limit: 10 });
    expect(queryRes.totalStudents).toBe(477);
    expect(queryRes.stats.mismatchCount).toBe(5);

    reopenedDb.close();
  });

  // -------------------------------------------------------------
  // I13: 拒絕非法檔且舊資料安全
  // -------------------------------------------------------------
  it('I13: 拒絕包含公式的非法試算表，拋出 422 且不影響現有資料庫', async () => {
    // 建立包含公式的假試算表
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);
    const r2 = ws.addRow(['STU-FORMULA', '公式學生', '分校', '國小輔導-一A[團]', '1', '', '']);
    r2.getCell(1).value = { formula: 'CONCAT("STU","001")', result: 'STU001' };

    const formulaBuf = await wb.xlsx.writeBuffer();

    await expect(async () => {
      await readErpWorkbook(Buffer.from(formulaBuf), { fileName: 'formula.xlsx' });
    }).rejects.toThrowError(ErpReaderError);

    // 驗證現有 DB 資料未受任何污染
    const active = getCurrentActiveRun(db);
    expect(active.revision).toBe(0);
  });

  // -------------------------------------------------------------
  // I14: 1000+ 行合成資料不截斷
  // -------------------------------------------------------------
  it('I14: 超過 1000 行（合成 1050 筆）試算表解析不截斷，筆數完全正確', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);

    const TOTAL_SYNTHETIC = 1050;
    for (let i = 1; i <= TOTAL_SYNTHETIC; i++) {
      ws.addRow([
        `STU_SYN_${String(i).padStart(5, '0')}`,
        `合成學生${i}`,
        '嘉義分校',
        '國小輔導-一A[團]',
        '1',
        '',
        '',
      ]);
    }

    const synthBuf = await wb.xlsx.writeBuffer();
    const result = await readErpWorkbook(Buffer.from(synthBuf), { fileName: 'synthetic-1050.xlsx' });

    expect(result.totalRows).toBe(TOTAL_SYNTHETIC);
    expect(result.students).toHaveLength(TOTAL_SYNTHETIC);
    expect(result.studentsWithClass).toBe(TOTAL_SYNTHETIC);
    expect(result.studentsWithoutClass).toBe(0);
    expect(result.students[0].personCode).toBe('STU_SYN_00001');
    expect(result.students[TOTAL_SYNTHETIC - 1].personCode).toBe(
      `STU_SYN_${String(TOTAL_SYNTHETIC).padStart(5, '0')}`
    );
  });

  // -------------------------------------------------------------
  // 安全性: Same-origin 防護
  // -------------------------------------------------------------
  it('安全防護: validateSameOrigin 應拒絕跨來源 Origin 寫入請求', () => {
    // 正常同來源請求 (Origin 符合 Host)
    const validReq = new NextRequest('http://127.0.0.1:3000/api/v1/imports/preview', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3000',
        origin: 'http://127.0.0.1:3000',
      },
    });
    expect(validateSameOrigin(validReq)).toBe(true);

    // 跨來源惡意請求 (Origin 不符合 Host)
    const evilReq = new NextRequest('http://127.0.0.1:3000/api/v1/imports/preview', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3000',
        origin: 'http://evil-attacker.com',
      },
    });
    expect(validateSameOrigin(evilReq)).toBe(false);

    // 無 Origin 但 Referer 跨來源
    const evilRefererReq = new NextRequest('http://127.0.0.1:3000/api/v1/imports/preview', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3000',
        referer: 'http://malicious-site.com/attack',
      },
    });
    expect(validateSameOrigin(evilRefererReq)).toBe(false);
  });

  // -------------------------------------------------------------
  // 安全性: 路徑參數驗證防範注入與遍歷
  // -------------------------------------------------------------
  it('安全防護: sanitizePathParam 應阻擋路徑遍歷與非法字元', () => {
    expect(sanitizePathParam('valid_run-123')).toBe('valid_run-123');
    expect(sanitizePathParam('prev_abcdef123_456')).toBe('prev_abcdef123_456');

    // 路徑遍歷攻擊
    expect(() => sanitizePathParam('../../etc/passwd')).toThrow();
    expect(() => sanitizePathParam('run/../secret')).toThrow();
    expect(() => sanitizePathParam('STU\0injection')).toThrow();
    expect(() => sanitizePathParam('')).toThrow();
  });

  // -------------------------------------------------------------
  // 03 §5 查詢參數契約測試
  // -------------------------------------------------------------
  it('03 §5 查詢參數規則: tierComparison 與 tierMismatch 矛盾應回傳 400', () => {
    const actRes = activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: 't06-param-test-key',
    });

    // tierMismatch=true 但 tierComparison=match 為矛盾
    expect(() => {
      queryRunStudents(db, actRes.runId, {
        tierMismatch: 'true',
        tierComparison: 'match',
      });
    }).toThrowError(QueryStudentError);

    // tierMismatch=false 但 tierComparison=mismatch 為矛盾
    expect(() => {
      queryRunStudents(db, actRes.runId, {
        tierMismatch: 'false',
        tierComparison: 'mismatch',
      });
    }).toThrowError(QueryStudentError);
  });

  it('03 §5 查詢參數規則: hasIssues=false 與 issueCode 同時指定應回傳 400', () => {
    const actRes = activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: 't06-issues-param-test-key',
    });

    expect(() => {
      queryRunStudents(db, actRes.runId, {
        hasIssues: 'false',
        issueCode: 'SCHEDULE_NOT_FOUND',
      });
    }).toThrowError(QueryStudentError);
  });

  it('03 §5 查詢參數規則: billingTier 缺少 careType 應回傳 400；未知 issueCode 回傳 400', () => {
    const actRes = activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: 't06-billing-tier-test-key',
    });

    // billingTier 必須同時帶 careType
    expect(() => {
      queryRunStudents(db, actRes.runId, {
        billingTier: '4.5',
      });
    }).toThrowError(QueryStudentError);

    // 未知 issueCode 必須回傳 400
    expect(() => {
      queryRunStudents(db, actRes.runId, {
        issueCode: 'UNKNOWN_CODE_XYZ',
      });
    }).toThrowError(QueryStudentError);
  });
});
