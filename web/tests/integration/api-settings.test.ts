import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport } from '@/application/activate-import';
import { buildApprovedLegacyMigrationFixtureDraft, saveApprovedLegacyMigrationFixtureSettings } from '../helpers/d1-test-kit';
import type { SettingsDraft } from '@/contracts/settings';
import { POST as previewPOST } from '@/app/api/v1/settings/preview/route';
import { POST as applyPOST } from '@/app/api/v1/settings/apply/route';

/** v4 baseline after approved one-time migration, plus the D18 alias preview. */
let migratedSeedDraft: SettingsDraft;

function seedDraft() {
  return migratedSeedDraft;
}

describe('T05: 設定 preview/apply API 契約測試', () => {
  let tempDir: string;
  let tempDbPath: string;
  let previewId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-t05-api-'));
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
    const migratedBaseDraft = await saveApprovedLegacyMigrationFixtureSettings(db, 'approved-legacy-migration');
    migratedSeedDraft = await buildApprovedLegacyMigrationFixtureDraft({
      ...migratedBaseDraft,
      aliases: [{ rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' }],
    });
    activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: `t05-api-setup-${Date.now()}-${Math.random()}`,
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

  it('POST /api/v1/settings/preview 回傳 previewId/inputHash 與 13人/-0.5/5→18', async () => {
    const req = new NextRequest('http://127.0.0.1:3000/api/v1/settings/preview', {
      method: 'POST',
      body: JSON.stringify({ importId: previewId, draft: seedDraft(), expectedRevision: 1 }),
    });
    const res = await previewPOST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.previewId).toBeDefined();
    expect(body.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.affectedStudents).toBe(13);
    expect(body.mismatchBefore).toBe(5);
    expect(body.mismatchAfter).toBe(18);
  });

  it('POST /api/v1/settings/preview 過期 revision 回 409（importId 不再必填：09 §8.2.2，缺／不符行為見 settings-import-server-decided.test.ts）', async () => {
    const staleReq = new NextRequest('http://127.0.0.1:3000/api/v1/settings/preview', {
      method: 'POST',
      body: JSON.stringify({ importId: previewId, draft: seedDraft(), expectedRevision: 0 }),
    });
    expect((await previewPOST(staleReq)).status).toBe(409);
  });

  it('POST /api/v1/settings/apply 套用成功 revision 2；版本衝突回 409', async () => {
    const prevReq = new NextRequest('http://127.0.0.1:3000/api/v1/settings/preview', {
      method: 'POST',
      body: JSON.stringify({ importId: previewId, draft: seedDraft(), expectedRevision: 1 }),
    });
    const prevBody = await (await previewPOST(prevReq)).json();

    const applyReq = new NextRequest('http://127.0.0.1:3000/api/v1/settings/apply', {
      method: 'POST',
      body: JSON.stringify({
        previewId: prevBody.previewId,
        expectedRevision: 1,
        idempotencyKey: 't05-api-apply-1',
      }),
    });
    const applyRes = await applyPOST(applyReq);
    expect(applyRes.status).toBe(200);
    const applied = await applyRes.json();
    expect(applied.revision).toBe(2);
    expect(applied.mismatchCount).toBe(18);

    // 版本已前進，舊 previewId＋新 revision 不一致 → 409
    const conflictReq = new NextRequest('http://127.0.0.1:3000/api/v1/settings/apply', {
      method: 'POST',
      body: JSON.stringify({
        previewId: prevBody.previewId,
        expectedRevision: 2,
        idempotencyKey: 't05-api-apply-2',
      }),
    });
    expect((await applyPOST(conflictReq)).status).toBe(409);
  });
});
