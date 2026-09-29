import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NextRequest } from 'next/server';
import { createDatabase } from '@/adapters/sqlite/db';
import { getDatabase } from '@/adapters/sqlite';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport } from '@/application/activate-import';
import { previewSettingsChange, SettingsPreviewError } from '@/application/settings-preview';
import { applySettingsPreview, SettingsApplyError } from '@/application/apply-settings';
import { buildSeedDraft, hashSettingsDraft, saveSettingsPreview } from '@/adapters/sqlite/settings-repository';
import { POST as previewPOST } from '@/app/api/v1/settings/preview/route';

/**
 * 09 §8.2.2／04 §8 UX02、UX04（importId case）／Plan 10 R1a(B5)：
 * 設定 preview／apply 的 import 一律由 server 依 active_state 決定。
 * client 傳入的 importId 僅作一致性檢查：與 server 決定值不符（傳非 active 的 ready 批次、
 * 或以 null 繞過 active）一律拒絕，且 active_state 不變、不寫入任何預覽／設定版本／run，
 * 不得「儲存設定順便啟用別批名單」。
 *
 * R1a 時無 active 一律拒絕（404）；R1b 起無 active 由 server 判為 settings_only（09 §8.2.3），
 * 仍不採用／不啟用 ready 批次。UX02「儲存課表再 activate」與 settings_only 競爭見 settings-only.test.ts。
 */

type SeedDraft = ReturnType<typeof buildSeedDraft>;

interface ActiveRow {
  active_import_id: string | null;
  active_run_id: string | null;
  revision: number;
}

/** 與 seed 不同的 draft（一→一A 對應），用來確認 apply 若成功會留下設定版本。 */
function aliasDraft(): SeedDraft {
  const seed = buildSeedDraft();
  return { ...seed, aliases: [{ rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' }] };
}

describe('R1a(B5)：settings preview／apply 的 import 由 server 依 active_state 決定', () => {
  let tempDir: string;
  let db: any;
  let preview: Awaited<ReturnType<typeof generateImportPreview>>;

  function saveBatch(suffix: string): string {
    const id = `imp_b5_${suffix}`;
    saveImportBatch(
      db,
      {
        id,
        fileName: `fixture-${suffix}.xlsx`,
        fileHash: `${preview.fileHash}-${suffix}`,
        contentHash: `${preview.contentHash}-${suffix}`,
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
    return id;
  }

  function activeState(): ActiveRow {
    return db
      .prepare('SELECT active_import_id, active_run_id, revision FROM active_state WHERE id = 1')
      .get() as ActiveRow;
  }

  function count(table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  /** 寫入面的完整快照：任何被拒絕的請求都必須讓它保持不變。 */
  function writeSurface() {
    return {
      active: activeState(),
      runs: count('calculation_runs'),
      versions: count('settings_versions'),
      previews: count('settings_previews'),
      idempotency: count('idempotency_records'),
      batchStatuses: db.prepare('SELECT id, status FROM import_batches ORDER BY id').all(),
    };
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-b5-test-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);
    const buf = fs.readFileSync(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
    preview = await generateImportPreview(buf, 'fixture.xlsx');
  });

  afterEach(() => {
    if (db) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('UX02：只有 ready 批次（無 active）——儲存設定不得啟用 ready', () => {
    it('preview 帶 client 傳的 ready importId：400 IMPORT_MISMATCH，active_state 與所有表不變', () => {
      const ready = saveBatch('ready');
      const before = writeSurface();
      expect(before.active).toMatchObject({ active_import_id: null, active_run_id: null, revision: 0 });

      let caught: unknown;
      try {
        previewSettingsChange(db, ready, { draft: aliasDraft(), expectedRevision: 0 });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SettingsPreviewError);
      expect(caught).toMatchObject({ statusCode: 400, code: 'IMPORT_MISMATCH' });
      expect(writeSurface()).toEqual(before);
    });

    it('preview 不帶 importId 且無 active：server 判為 settings_only，不採用 ready 批次（R1b）；ready 維持 ready、active 不變', () => {
      const ready = saveBatch('ready');
      const result = previewSettingsChange(db, undefined, { draft: aliasDraft(), expectedRevision: 0 });
      expect(result.mode).toBe('settings_only');
      const row = db.prepare('SELECT import_id FROM settings_previews WHERE preview_id = ?').get(result.previewId) as {
        import_id: string | null;
      };
      expect(row.import_id).toBeNull();
      expect(activeState()).toMatchObject({ active_import_id: null, active_run_id: null, revision: 0 });
      const batch = db.prepare('SELECT status FROM import_batches WHERE id = ?').get(ready) as { status: string };
      expect(batch.status).toBe('ready');
    });

    it('client 以 null 表示無名單且無 active：與 server 決定值一致，走 settings_only，不寫入 active／run', () => {
      saveBatch('ready');
      const result = previewSettingsChange(db, null, { draft: aliasDraft(), expectedRevision: 0 });
      expect(result.mode).toBe('settings_only');
      expect(activeState()).toMatchObject({ active_import_id: null, active_run_id: null, revision: 0 });
      expect(count('calculation_runs')).toBe(0);
    });

    it('apply 遇到鎖在 ready 批次的預覽（舊資料或竄改）：拒絕，不啟用該批、不建 run／設定版本', () => {
      const ready = saveBatch('ready');
      const draft = aliasDraft();
      const inputHash = hashSettingsDraft(draft);
      const now = new Date();
      saveSettingsPreview(db, {
        previewId: 'setprev_forged_ready',
        inputHash,
        draftJson: JSON.stringify(draft),
        expectedRevision: 0,
        settingsVersionId: 'seed-v250922',
        importId: ready,
        resultJson: '{}',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      });
      const before = writeSurface();

      let caught: unknown;
      try {
        applySettingsPreview(db, {
          previewId: 'setprev_forged_ready',
          expectedRevision: 0,
          idempotencyKey: 'b5-forged-ready',
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SettingsApplyError);
      expect(caught).toMatchObject({ statusCode: 409, code: 'IMPORT_MISMATCH' });
      expect(writeSurface()).toEqual(before);
      expect(activeState().active_import_id).toBeNull();
    });
  });

  describe('UX04（importId case）：有 active 時 client importId 與 server 決定值不符即被拒', () => {
    let importA: string;
    let importB: string;

    beforeEach(() => {
      importA = saveBatch('a');
      importB = saveBatch('b');
      activateImport(db, { importId: importA, expectedRevision: 0, idempotencyKey: 'b5-act-a' });
    });

    it('preview 帶非 active 的 ready 批次 B：400 IMPORT_MISMATCH，active 仍是 A，不寫入預覽', () => {
      const before = writeSurface();
      expect(before.active).toMatchObject({ active_import_id: importA, revision: 1 });

      let caught: unknown;
      try {
        previewSettingsChange(db, importB, { draft: aliasDraft(), expectedRevision: 1 });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SettingsPreviewError);
      expect(caught).toMatchObject({ statusCode: 400, code: 'IMPORT_MISMATCH' });
      expect(writeSurface()).toEqual(before);
    });

    it('preview 以 null 繞過 active：400 IMPORT_MISMATCH，不寫入預覽', () => {
      const before = writeSurface();
      expect(() => previewSettingsChange(db, null, { draft: aliasDraft(), expectedRevision: 1 })).toThrowError(
        expect.objectContaining({ statusCode: 400, code: 'IMPORT_MISMATCH' })
      );
      expect(writeSurface()).toEqual(before);
    });

    it('preview 帶空字串或非字串 importId：一律視為不符（不採用 client 值）', () => {
      const before = writeSurface();
      for (const bad of ['', 123, {}, [importA]]) {
        expect(() => previewSettingsChange(db, bad, { draft: aliasDraft(), expectedRevision: 1 })).toThrowError(
          expect.objectContaining({ statusCode: 400, code: 'IMPORT_MISMATCH' })
        );
      }
      expect(writeSurface()).toEqual(before);
    });

    it('preview 不帶 importId：採 server 決定的 active import A，預覽鎖定 A；apply 後 active_import_id 仍是 A', () => {
      const prev = previewSettingsChange(db, undefined, { draft: aliasDraft(), expectedRevision: 1 });
      const row = db.prepare('SELECT import_id FROM settings_previews WHERE preview_id = ?').get(prev.previewId) as {
        import_id: string;
      };
      expect(row.import_id).toBe(importA);

      const applied = applySettingsPreview(db, {
        previewId: prev.previewId,
        expectedRevision: 1,
        idempotencyKey: 'b5-apply-omit',
      });
      const state = activeState();
      expect(state.active_import_id).toBe(importA);
      expect(state.active_run_id).toBe(applied.runId);
      const run = db.prepare('SELECT import_id FROM calculation_runs WHERE id = ?').get(applied.runId) as {
        import_id: string;
      };
      expect(run.import_id).toBe(importA);
      const batchB = db.prepare('SELECT status FROM import_batches WHERE id = ?').get(importB) as { status: string };
      expect(batchB.status).toBe('ready');
    });

    it('preview 帶與 server 決定值相同的 importId A（過渡期一致性檢查）：通過，預覽鎖定 A', () => {
      const prev = previewSettingsChange(db, importA, { draft: aliasDraft(), expectedRevision: 1 });
      const row = db.prepare('SELECT import_id FROM settings_previews WHERE preview_id = ?').get(prev.previewId) as {
        import_id: string;
      };
      expect(row.import_id).toBe(importA);
    });

    it('apply 遇到鎖在非 active 批次 B 的預覽：409 IMPORT_MISMATCH，active 仍是 A，不建 run／設定版本／冪等紀錄', () => {
      const draft = aliasDraft();
      const now = new Date();
      saveSettingsPreview(db, {
        previewId: 'setprev_forged_b',
        inputHash: hashSettingsDraft(draft),
        draftJson: JSON.stringify(draft),
        expectedRevision: 1,
        settingsVersionId: 'seed-v250922',
        importId: importB,
        resultJson: '{}',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      });
      const before = writeSurface();

      let caught: unknown;
      try {
        applySettingsPreview(db, {
          previewId: 'setprev_forged_b',
          expectedRevision: 1,
          idempotencyKey: 'b5-forged-b',
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SettingsApplyError);
      expect(caught).toMatchObject({ statusCode: 409, code: 'IMPORT_MISMATCH' });
      expect(writeSurface()).toEqual(before);
      expect(activeState().active_import_id).toBe(importA);
    });

    it('拒絕後 active 與 A 的 run 完全不受影響，之後正常的儲存仍可成功', () => {
      const before = writeSurface();
      expect(() => previewSettingsChange(db, importB, { draft: aliasDraft(), expectedRevision: 1 })).toThrow();
      expect(writeSurface()).toEqual(before);

      const prev = previewSettingsChange(db, importA, { draft: aliasDraft(), expectedRevision: 1 });
      const applied = applySettingsPreview(db, {
        previewId: prev.previewId,
        expectedRevision: 1,
        idempotencyKey: 'b5-after-reject',
      });
      expect(applied.revision).toBe(2);
      expect(activeState().active_import_id).toBe(importA);
    });
  });
});

describe('R1a(B5)：POST /api/v1/settings/preview route', () => {
  let tempDir: string;
  let importA: string;
  let importB: string;

  function req(body: unknown): NextRequest {
    return new NextRequest('http://127.0.0.1:3000/api/v1/settings/preview', {
      method: 'POST',
      headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
      body: JSON.stringify(body),
    });
  }

  function state(db: any): ActiveRow {
    return db
      .prepare('SELECT active_import_id, active_run_id, revision FROM active_state WHERE id = 1')
      .get() as ActiveRow;
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-b5-route-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    (global as any).__sqlite_db__ = undefined;
    const db = getDatabase() as any;

    const buf = fs.readFileSync(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
    const preview = await generateImportPreview(buf, 'fixture.xlsx');
    const save = (id: string, suffix: string) =>
      saveImportBatch(
        db,
        {
          id,
          fileName: `fixture-${suffix}.xlsx`,
          fileHash: `${preview.fileHash}-${suffix}`,
          contentHash: `${preview.contentHash}-${suffix}`,
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
    importA = 'imp_b5_route_a';
    importB = 'imp_b5_route_b';
    save(importA, 'a');
    save(importB, 'b');
    activateImport(db, { importId: importA, expectedRevision: 0, idempotencyKey: 'b5-route-act-a' });
  });

  afterEach(() => {
    if ((global as any).__sqlite_db__) {
      (global as any).__sqlite_db__.close();
      (global as any).__sqlite_db__ = undefined;
    }
    delete process.env.DATABASE_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('client 傳非 active 的 importId：400 IMPORT_MISMATCH，active_state 不變、不落預覽', async () => {
    const db = getDatabase() as any;
    const before = state(db);
    const res = await previewPOST(req({ importId: importB, draft: aliasDraft(), expectedRevision: 1 }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('IMPORT_MISMATCH');
    expect(state(db)).toEqual(before);
    expect((db.prepare('SELECT COUNT(*) AS n FROM settings_previews').get() as { n: number }).n).toBe(0);
  });

  it('client 以 null 繞過 active：400 IMPORT_MISMATCH', async () => {
    const res = await previewPOST(req({ importId: null, draft: aliasDraft(), expectedRevision: 1 }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('IMPORT_MISMATCH');
  });

  it('client 不帶 importId：不再回 MISSING_IMPORT_ID，改由 server 採 active import（200，預覽鎖定 A）', async () => {
    const db = getDatabase() as any;
    const res = await previewPOST(req({ draft: aliasDraft(), expectedRevision: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = db.prepare('SELECT import_id FROM settings_previews WHERE preview_id = ?').get(body.previewId) as {
      import_id: string;
    };
    expect(row.import_id).toBe(importA);
    expect(state(db).active_import_id).toBe(importA);
  });
});
