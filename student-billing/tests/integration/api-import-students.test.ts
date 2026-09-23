import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { GET } from '@/app/api/v1/imports/[previewId]/students/route';

describe('API: GET /api/v1/imports/[previewId]/students', () => {
  let tempDir: string;
  let tempDbPath: string;
  let previewId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-api-students-test-'));
    tempDbPath = path.join(tempDir, 'test.sqlite');
    process.env.DATABASE_PATH = tempDbPath;

    if (global.__sqlite_db__) {
      global.__sqlite_db__.close();
      global.__sqlite_db__ = undefined;
    }

    const db = getDatabase();
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
    if (global.__sqlite_db__) {
      global.__sqlite_db__.close();
      global.__sqlite_db__ = undefined;
    }
    delete process.env.DATABASE_PATH;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('正常查詢應回傳 200 與分頁資料', async () => {
    const req = new NextRequest(`http://127.0.0.1:3000/api/v1/imports/${previewId}/students?limit=10`);
    const res = await GET(req, { params: Promise.resolve({ previewId }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.items).toHaveLength(10);
    expect(body.totalStudents).toBe(477);
    expect(body.nextCursor).toBeDefined();
  });

  it('03 §5 契約: 傳入正式計算專屬參數 (runId 等) 應回傳 400', async () => {
    const req = new NextRequest(`http://127.0.0.1:3000/api/v1/imports/${previewId}/students?runId=test-run`);
    const res = await GET(req, { params: Promise.resolve({ previewId }) });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('runId');
  });

  it('03 §5 契約: 傳入未知參數應回傳 400', async () => {
    const req = new NextRequest(`http://127.0.0.1:3000/api/v1/imports/${previewId}/students?someInvalidParam=123`);
    const res = await GET(req, { params: Promise.resolve({ previewId }) });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('someInvalidParam');
  });
});
