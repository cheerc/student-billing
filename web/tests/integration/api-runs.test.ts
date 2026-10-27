import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { POST as activatePOST } from '@/app/api/v1/imports/[previewId]/activate/route';
import { GET as currentGET } from '@/app/api/v1/runs/current/route';
import { GET as studentsGET } from '@/app/api/v1/runs/[runId]/students/route';
import { GET as studentDetailGET } from '@/app/api/v1/runs/[runId]/students/[personCode]/route';
import { saveApprovedLegacyMigrationFixtureSettings } from '../helpers/d1-test-kit';

describe('T04: 正式 Run 相關 API 整合測試 (03 §5)', () => {
  let tempDir: string;
  let tempDbPath: string;
  let previewId: string;
  let runId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-api-runs-test-'));
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
    await saveApprovedLegacyMigrationFixtureSettings(db, 'approved-legacy-migration');

    // 透過 activate API 啟用
    const activateReq = new NextRequest(
      `http://127.0.0.1:3000/api/v1/imports/${previewId}/activate`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: 0,
          idempotencyKey: 'test-api-act-key',
        }),
      }
    );
    const activateRes = await activatePOST(activateReq, {
      params: Promise.resolve({ previewId }),
    });
    const actBody = await activateRes.json();
    runId = actBody.runId;
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

  it('GET /api/v1/runs/current 應回傳當前 active run 與 revision 1', async () => {
    const res = await currentGET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.revision).toBe(1);
    expect(body.activeRunId).toBe(runId);
    expect(body.run).toBeDefined();
    expect(body.run.id).toBe(runId);
  });

  it('GET /api/v1/runs/{runId}/students 支援分頁與 tierMismatch 篩選', async () => {
    const req = new NextRequest(
      `http://127.0.0.1:3000/api/v1/runs/${runId}/students?tierMismatch=true`
    );
    const res = await studentsGET(req, {
      params: Promise.resolve({ runId }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.totalStudents).toBe(4);
    expect(body.items).toHaveLength(4);
  });

  it('GET /api/v1/runs/{runId}/students/{personCode} 應回傳單一學生完整明細，無匹配回傳 404', async () => {
    const reqOk = new NextRequest(
      `http://127.0.0.1:3000/api/v1/runs/${runId}/students/STU0001`
    );
    const resOk = await studentDetailGET(reqOk, {
      params: Promise.resolve({ runId, personCode: 'STU0001' }),
    });
    expect(resOk.status).toBe(200);
    const detail = await resOk.json();
    expect(detail.personCode).toBe('STU0001');
    expect(detail.trace).toBeDefined();

    const req404 = new NextRequest(
      `http://127.0.0.1:3000/api/v1/runs/${runId}/students/NONEXISTENT`
    );
    const res404 = await studentDetailGET(req404, {
      params: Promise.resolve({ runId, personCode: 'NONEXISTENT' }),
    });
    expect(res404.status).toBe(404);
  });

});
