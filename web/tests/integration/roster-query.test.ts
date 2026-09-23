import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch, getImportBatch } from '@/adapters/sqlite/import-repository';
import { queryImportStudents, RosterQueryError } from '@/application/roster-query';
import { generateImportPreview } from '@/application/import-preview';

describe('T02: 名單篩選與持久化整合測試 (I07, I08, I12, 03 §5 白名單)', () => {
  let tempDir: string;
  let tempDbPath: string;
  let db: any;
  let previewId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-roster-test-'));
    tempDbPath = path.join(tempDir, 'test.sqlite');
    db = createDatabase(tempDbPath);
    runMigrations(db);

    // 載入 fixture 並寫入 DB
    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    const buf = fs.readFileSync(fixturePath);
    const preview = await generateImportPreview(buf, 'fixture.xlsx');
    previewId = preview.previewId;

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
      createdAt: new Date().toISOString(),
    }, preview.students);
  });

  afterEach(() => {
    if (db) db.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('I07: 重開 DB 後資料依然保留，且能判定重複上傳', async () => {
    // 關閉並重開 DB
    db.close();
    db = createDatabase(tempDbPath);

    const batch = getImportBatch(db, previewId);
    expect(batch).toBeDefined();
    expect(batch?.status).toBe('ready');
    expect(batch?.rowCount).toBe(477);

    // 重複寫入相同 fileHash 應被識別為重複
    const dupRes = saveImportBatch(db, {
      id: 'another_id',
      fileName: 'fixture_copy.xlsx',
      fileHash: batch!.fileHash,
      contentHash: batch!.contentHash,
      sheetName: 'Sheet1',
      headerMap: {},
      parserVersion: '1.0.0',
      scopeNote: '',
      rowCount: 477,
      status: 'ready',
      createdAt: new Date().toISOString(),
    }, []);
    expect(dupRes.isDuplicate).toBe(true);
    expect(dupRes.duplicateReason).toBe('same_file');
  });

  it('03 §5 白名單契約: 傳入正式計算專屬參數或未知參數應拋出 400', () => {
    // 傳入 runId
    expect(() => {
      queryImportStudents(db, previewId, { runId: 'run-123' } as any);
    }).toThrowError(RosterQueryError);

    try {
      queryImportStudents(db, previewId, { runId: 'run-123' } as any);
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain('runId');
    }

    // 傳入 tierMismatch
    try {
      queryImportStudents(db, previewId, { tierMismatch: true } as any);
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain('tierMismatch');
    }

    // 傳入 hasIssues
    try {
      queryImportStudents(db, previewId, { hasIssues: true } as any);
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain('hasIssues');
    }

    // 傳入未知參數
    try {
      queryImportStudents(db, previewId, { unknownParamX: 'val' } as any);
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain('unknownParamX');
    }
  });

  it('I12: 分頁 (limit/cursor) 契約與穩定順序', () => {
    // 第一頁取 50 筆
    const page1 = queryImportStudents(db, previewId, { limit: 50 });
    expect(page1.items).toHaveLength(50);
    expect(page1.totalStudents).toBe(477);
    expect(page1.nextCursor).toBeDefined();

    // 第二頁帶 cursor 取 50 筆
    const page2 = queryImportStudents(db, previewId, {
      limit: 50,
      cursor: page1.nextCursor!,
    });
    expect(page2.items).toHaveLength(50);

    // 兩頁資料不重複
    const codes1 = new Set(page1.items.map((s) => s.personCode));
    const codes2 = new Set(page2.items.map((s) => s.personCode));
    for (const c of codes1) {
      expect(codes2.has(c)).toBe(false);
    }

    // 無效 cursor 應回傳 400
    expect(() => {
      queryImportStudents(db, previewId, { cursor: 'invalid_base64_!@#$' });
    }).toThrowError(RosterQueryError);
  });

  it('篩選支援：班級候選 (A/B 分開)、年級、有無班級與姓名代碼搜尋', () => {
    // 1. 篩選無班級學生 (93 筆)
    const noClassRes = queryImportStudents(db, previewId, { hasClass: 'false', limit: 200 });
    expect(noClassRes.totalStudents).toBe(93);
    expect(noClassRes.items.every((s) => s.enrollments.length === 0)).toBe(true);

    // 2. 篩選有班級學生 (384 筆)
    const withClassRes = queryImportStudents(db, previewId, { hasClass: 'true', limit: 50 });
    expect(withClassRes.totalStudents).toBe(384);
    expect(withClassRes.items.every((s) => s.enrollments.length > 0)).toBe(true);

    // 3. 班級候選精確匹配 四年級 A 班 vs 四年級 B 班
    const res4A = queryImportStudents(db, previewId, {
      enrollmentKey: '國小輔導-四年級A',
      limit: 100,
    });
    const res4B = queryImportStudents(db, previewId, {
      enrollmentKey: '國小輔導-四年級B',
      limit: 100,
    });

    expect(res4A.totalStudents).toBeGreaterThan(0);
    expect(res4B.totalStudents).toBeGreaterThan(0);
    // 兩班學生名單完全獨立
    const setA = new Set(res4A.items.map((s) => s.personCode));
    const setB = new Set(res4B.items.map((s) => s.personCode));
    for (const c of setA) {
      expect(setB.has(c)).toBe(false);
    }

    // 4. 代碼搜尋
    const searchRes = queryImportStudents(db, previewId, { q: 'STU0001' });
    expect(searchRes.items).toHaveLength(1);
    expect(searchRes.items[0].personCode).toBe('STU0001');
  });
});
