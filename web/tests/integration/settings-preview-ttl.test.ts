import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport } from '@/application/activate-import';
import { POST as previewPOST } from '@/app/api/v1/settings/preview/route';
import { POST as applyPOST } from '@/app/api/v1/settings/apply/route';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { SEED_CLASSES } from '@/domain/schedules/seed-manifest';

describe('D1 Task 2: 預覽 TTL 逾期 400 與 formal-only 整合測試', () => {
  let tempDir: string;
  let tempDbPath: string;
  let previewId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-t05-ttl-'));
    tempDbPath = path.join(tempDir, 'test.sqlite');
    process.env.DATABASE_PATH = tempDbPath;
    if ((global as any).__sqlite_db__) {
      (global as any).__sqlite_db__.close();
      (global as any).__sqlite_db__ = undefined;
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
    activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: `ttl-setup-${Date.now()}-${Math.random()}`,
    });
  });

  afterEach(() => {
    if ((global as any).__sqlite_db__) {
      (global as any).__sqlite_db__.close();
      (global as any).__sqlite_db__ = undefined;
    }
    delete process.env.DATABASE_PATH;
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('1. POST /api/v1/settings/preview 回傳應帶有 expiresAt (TTL 15 分鐘)', async () => {
    const draft = buildSeedDraft(SEED_CLASSES, {
      anqin: { start: 780, end: 960 },
      tutoring: { start: 990, end: 1170 },
    });
    const req = new NextRequest('http://127.0.0.1:3000/api/v1/settings/preview', {
      method: 'POST',
      body: JSON.stringify({ importId: previewId, draft, expectedRevision: 1 }),
    });
    const res = await previewPOST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.expiresAt).toBeDefined();
    const expiresTime = new Date(body.expiresAt).getTime();
    const now = Date.now();
    // 預期大約在 15 分鐘後 (850s ~ 950s)
    expect(expiresTime - now).toBeGreaterThan(800 * 1000);
    expect(expiresTime - now).toBeLessThan(1000 * 1000);
  });

  it('2. 逾期之 previewId 於 apply 時應遭拒絕並回傳 400 PREVIEW_EXPIRED (RED)', async () => {
    const draft = buildSeedDraft(SEED_CLASSES, {
      anqin: { start: 780, end: 960 },
      tutoring: { start: 990, end: 1170 },
    });
    const prevReq = new NextRequest('http://127.0.0.1:3000/api/v1/settings/preview', {
      method: 'POST',
      body: JSON.stringify({ importId: previewId, draft, expectedRevision: 1 }),
    });
    const prevRes = await previewPOST(prevReq);
    const prevBody = await prevRes.json();

    // 手動將 SQLite 中的 expires_at 改為過去的時間（模擬已逾期）
    const db = getDatabase();
    const pastTime = new Date(Date.now() - 60 * 1000).toISOString();
    db.prepare('UPDATE settings_previews SET expires_at = ? WHERE preview_id = ?').run(
      pastTime,
      prevBody.previewId
    );

    const applyReq = new NextRequest('http://127.0.0.1:3000/api/v1/settings/apply', {
      method: 'POST',
      body: JSON.stringify({
        previewId: prevBody.previewId,
        expectedRevision: 1,
        idempotencyKey: `apply-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      }),
    });
    const applyRes = await applyPOST(applyReq);
    expect(applyRes.status).toBe(400);
    const applyBody = await applyRes.json();
    expect(applyBody.error || applyBody.message).toMatch(/過期|PREVIEW_EXPIRED/);
  });
});
