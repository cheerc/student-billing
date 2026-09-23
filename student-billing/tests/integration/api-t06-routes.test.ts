import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { POST as activatePOST } from '@/app/api/v1/imports/[previewId]/activate/route';
import { GET as importsGET } from '@/app/api/v1/imports/route';
import { GET as runsGET } from '@/app/api/v1/runs/route';
import { GET as singleRunGET } from '@/app/api/v1/runs/[runId]/route';
import { GET as issuesGET } from '@/app/api/v1/runs/[runId]/issues/route';
import { GET as classesGET } from '@/app/api/v1/classes/route';

describe('T06: 剩餘 P1 讀取端點整合測試 (03 §5)', () => {
  let tempDir: string;
  let tempDbPath: string;
  let previewId: string;
  let runId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-api-t06-test-'));
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

    const activateReq = new NextRequest(
      `http://127.0.0.1:3000/api/v1/imports/${previewId}/activate`,
      {
        method: 'POST',
        headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
        body: JSON.stringify({
          expectedRevision: 0,
          idempotencyKey: 'test-api-t06-act-key',
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

  it('GET /api/v1/imports 應回傳批次清單且不包含敏感 raw notes', async () => {
    const res = await importsGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.items[0].id).toBe(previewId);
    expect(body.items[0].fileName).toBe('fixture.xlsx');
    expect(body.items[0].rowCount).toBe(477);
    // 確認不暴露 raw notes
    expect(body.items[0].notesRaw).toBeUndefined();
    expect(body.items[0].notes).toBeUndefined();
  });

  it('GET /api/v1/runs 應回傳所有計算 run 並標示 active 狀態', async () => {
    const res = await runsGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalRuns).toBeGreaterThanOrEqual(1);
    expect(body.activeRunId).toBe(runId);
    expect(body.activeRevision).toBe(1);

    const target = body.runs.find((r: any) => r.id === runId);
    expect(target).toBeDefined();
    expect(target.isActive).toBe(true);
    expect(target.totalStudents).toBe(477);
    expect(target.issueCounts['DUPLICATE_SUBJECT_ENROLLMENT']).toBe(2);
  });

  it('GET /api/v1/runs/[runId] 應回傳單一 run 完整 metadata', async () => {
    const req = new NextRequest(`http://127.0.0.1:3000/api/v1/runs/${runId}`);
    const res = await singleRunGET(req, { params: Promise.resolve({ runId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(runId);
    expect(body.isActive).toBe(true);
    expect(body.ruleSetVersion).toBe('erp-tag-v1');
    expect(body.numericPolicy).toBe('integer-minute-rational-v1');
  });

  it('GET /api/v1/runs/[runId]/issues 支援按 issueCode 篩選', async () => {
    // 篩選 DUPLICATE_SUBJECT_ENROLLMENT (預期 2 筆)
    const req = new NextRequest(
      `http://127.0.0.1:3000/api/v1/runs/${runId}/issues?issueCode=DUPLICATE_SUBJECT_ENROLLMENT`
    );
    const res = await issuesGET(req, { params: Promise.resolve({ runId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalIssues).toBe(2);
    expect(body.items.every((it: any) => it.issueCode === 'DUPLICATE_SUBJECT_ENROLLMENT')).toBe(true);

    // 篩選 STAFF_FAMILY_NO_DISCOUNT (預期 5 筆)
    const staffReq = new NextRequest(
      `http://127.0.0.1:3000/api/v1/runs/${runId}/issues?issueCode=STAFF_FAMILY_NO_DISCOUNT`
    );
    const staffRes = await issuesGET(staffReq, { params: Promise.resolve({ runId }) });
    expect(staffRes.status).toBe(200);
    const staffBody = await staffRes.json();
    expect(staffBody.totalIssues).toBe(5);
  });

  it('GET /api/v1/classes 應回傳本批可見班級、科別、去重學生數與設定狀態', async () => {
    const req = new NextRequest(`http://127.0.0.1:3000/api/v1/classes?runId=${runId}`);
    const res = await classesGET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalClasses).toBeGreaterThanOrEqual(40);
    expect(body.items[0]).toHaveProperty('baseName');
    expect(body.items[0]).toHaveProperty('studentCount');
    expect(body.items[0]).toHaveProperty('mappingStatus');
    expect(body.items[0]).toHaveProperty('isConfigured');
  });
});
