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
import { activateImport, ActivateConflictError } from '@/application/activate-import';
import { previewSettingsChange } from '@/application/settings-preview';
import { executeCalculationRun } from '@/application/calculate-run';
import { applySettingsPreview, SettingsApplyError } from '@/application/apply-settings';
import { buildSeedDraft, hashSettingsDraft, saveSettingsPreview } from '@/adapters/sqlite/settings-repository';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { SettingsDraft } from '@/contracts/settings';
import { POST as previewPOST } from '@/app/api/v1/settings/preview/route';
import { POST as applyPOST } from '@/app/api/v1/settings/apply/route';

/**
 * 09 §8.2.3／04 §8 UX01–UX04（settings_only）／Plan 10 R1b：
 * 沒有現行名單（無 active import）時，preview／apply 由 server 判為 settings_only：
 * 只保存設定快照並遞增 revision；影響學生數為 null（不能寫 0 當作驗過）；runId＝null、
 * 不建假 run、不寫 student_calculations、不改 active import／run、不啟用任何 ready 批次。
 * 與 activate 的競爭仍由 revision CAS 擋下（一成功另一 409）。
 *
 * D18（既有已確認案例）作為 with_students 的對照：seed 全量 draft＋一→一A 別名 → 13 人各 −0.5。
 */

const ALIAS = { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' };

function draftWithAlias(): SettingsDraft {
  return { ...buildSeedDraft(), aliases: [ALIAS] };
}

interface ActiveRow {
  active_import_id: string | null;
  active_run_id: string | null;
  revision: number;
}

describe('settings_only：無現行名單時只存課表（UX01–UX04）', () => {
  let tempDir: string;
  let dbPath: string;
  let db: any;
  let filePreview: Awaited<ReturnType<typeof generateImportPreview>>;

  function saveBatch(id: string): string {
    saveImportBatch(
      db,
      {
        id,
        fileName: `${id}.xlsx`,
        fileHash: `${filePreview.fileHash}-${id}`,
        contentHash: `${filePreview.contentHash}-${id}`,
        sheetName: filePreview.sheetName,
        headerMap: filePreview.headerMapping,
        parserVersion: '1.0.0',
        scopeNote: filePreview.scopeNote,
        rowCount: filePreview.stats.totalStudents,
        status: 'ready',
        createdAt: new Date().toISOString(),
      },
      filePreview.students
    );
    return id;
  }

  const active = (): ActiveRow =>
    db.prepare('SELECT active_import_id, active_run_id, revision FROM active_state WHERE id = 1').get() as ActiveRow;
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  function saveSettingsOnly(expectedRevision: number, key: string, draft: SettingsDraft = draftWithAlias()) {
    const prev = previewSettingsChange(db, undefined, { draft, expectedRevision });
    const applied = applySettingsPreview(db, { previewId: prev.previewId, expectedRevision, idempotencyKey: key });
    return { prev, applied };
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-so-test-'));
    dbPath = path.join(tempDir, 'test.sqlite');
    db = createDatabase(dbPath);
    runMigrations(db);
    const buf = fs.readFileSync(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
    filePreview = await generateImportPreview(buf, 'fixture.xlsx');
  });

  afterEach(() => {
    if (db) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('UX01：空 DB 先改課表→確認→儲存→重啟', () => {
    it('preview 判為 settings_only：學生影響為 null（不是 0）、無差異明細，且不寫 active 資料', () => {
      const prev = previewSettingsChange(db, undefined, { draft: draftWithAlias(), expectedRevision: 0 });
      expect(prev.mode).toBe('settings_only');
      expect(prev.affectedStudents).toBeNull();
      expect(prev.dayDeltas).toBeNull();
      expect(prev.mismatchBefore).toBeNull();
      expect(prev.mismatchAfter).toBeNull();
      expect(prev.tierTransitions).toBeNull();
      expect(prev.issueDelta).toBeNull();
      expect(active()).toMatchObject({ active_import_id: null, active_run_id: null, revision: 0 });
      // 預覽鎖定「無名單」：import_id 為 NULL（migration 0006）
      const row = db.prepare('SELECT import_id FROM settings_previews WHERE preview_id = ?').get(prev.previewId) as any;
      expect(row.import_id).toBeNull();
    });

    it('apply：保存設定快照、revision 0→1、runId＝null；不建 run、不寫 student_calculations、active import／run 仍為 null', () => {
      const { applied } = saveSettingsOnly(0, 'so-1');
      expect(applied.runId).toBeNull();
      expect(applied.revision).toBe(1);
      expect(applied.totalStudents).toBeNull();
      expect(applied.mismatchCount).toBeNull();

      expect(count('settings_versions')).toBe(1);
      const ver = db.prepare('SELECT id, revision FROM settings_versions').get() as any;
      expect(ver).toEqual({ id: applied.settingsVersionId, revision: 1 });
      expect(count('calculation_runs')).toBe(0);
      expect(count('student_calculations')).toBe(0);
      expect(count('import_batches')).toBe(0);
      expect(active()).toEqual({ active_import_id: null, active_run_id: null, revision: 1 });
    });

    it('重啟（關閉再開同一個檔案並跑 migration）後設定與 revision 仍在、run 仍為 null', () => {
      const { applied } = saveSettingsOnly(0, 'so-restart');
      db.close();
      db = createDatabase(dbPath);
      runMigrations(db);
      expect(active()).toEqual({ active_import_id: null, active_run_id: null, revision: 1 });
      expect(db.prepare('SELECT id FROM settings_versions').all()).toEqual([{ id: applied.settingsVersionId }]);
      expect(count('calculation_runs')).toBe(0);
    });

    it('同一個 idempotencyKey＋同 body 重送：回原結果（runId 仍 null），不再產生新設定版本或遞增 revision', () => {
      const { prev, applied } = saveSettingsOnly(0, 'so-replay');
      const replay = applySettingsPreview(db, { previewId: prev.previewId, expectedRevision: 0, idempotencyKey: 'so-replay' });
      expect(replay).toEqual(applied);
      expect(count('settings_versions')).toBe(1);
      expect(active().revision).toBe(1);
      const idem = db.prepare('SELECT run_id FROM idempotency_records WHERE idempotency_key = ?').get('so-replay') as any;
      expect(idem.run_id).toBeNull();
    });
  });

  describe('UX02：只有 ready 批次——儲存課表不啟用它，之後 activate 採最新已儲存設定', () => {
    it('存在 ready 批次時 settings_only 儲存：ready 批次維持 ready、active 仍為 null；client 傳該 ready importId 被拒', () => {
      const ready = saveBatch('imp_so_ready');
      expect(() => previewSettingsChange(db, ready, { draft: draftWithAlias(), expectedRevision: 0 })).toThrowError(
        expect.objectContaining({ statusCode: 400, code: 'IMPORT_MISMATCH' })
      );
      expect(count('settings_previews')).toBe(0);

      saveSettingsOnly(0, 'so-ready-1');
      expect((db.prepare('SELECT status FROM import_batches WHERE id = ?').get(ready) as any).status).toBe('ready');
      expect(active().active_import_id).toBeNull();
      expect(count('calculation_runs')).toBe(0);
    });

    it('先存課表再 activate：run.scheduleVersionId＝該最新已儲存設定 id，並套用其別名（D18：13 位各 −0.5，相對無別名基準）', () => {
      const ready = saveBatch('imp_so_ready2');
      const { applied } = saveSettingsOnly(0, 'so-then-activate');
      const act = activateImport(db, { importId: ready, expectedRevision: applied.revision, idempotencyKey: 'so-act-1' });

      expect(getCalculationRun(db, act.runId)!.scheduleVersionId).toBe(applied.settingsVersionId);
      expect(active()).toMatchObject({ active_import_id: ready, active_run_id: act.runId, revision: applied.revision + 1 });

      // 獨立基準：同一批學生、尚無已儲存設定（無別名）的 seed 計算，不落庫
      const baseline = new Map(
        executeCalculationRun(db, ready, 'run_so_baseline', {}).results.map((r) => [r.personCode, r.anqinDays])
      );
      const actual = new Map(
        (
          db
            .prepare('SELECT person_code, anqin_days FROM student_calculations WHERE run_id = ?')
            .all(act.runId) as Array<{ person_code: string; anqin_days: number | null }>
        ).map((r) => [r.person_code, r.anqin_days])
      );
      // 受影響的 13 位以報名資料界定（D18），不取自計算結果
      const math1 = (
        db
          .prepare("SELECT DISTINCT person_code FROM student_enrollments WHERE import_id = ? AND base_name = '國小數學-一'")
          .all(ready) as Array<{ person_code: string }>
      ).map((r) => r.person_code);
      expect(math1).toHaveLength(13);
      const differing = [...actual.entries()].filter(([code, d]) => d !== baseline.get(code)).map(([code]) => code);
      expect(differing.sort()).toEqual([...math1].sort());
      for (const code of math1) {
        expect((actual.get(code) ?? 0) - (baseline.get(code) ?? 0)).toBeCloseTo(-0.5, 9);
      }
    });
  });

  describe('UX03：有 active 改時段——取消／失敗／成功', () => {
    let importA: string;

    beforeEach(() => {
      importA = saveBatch('imp_so_a');
      activateImport(db, { importId: importA, expectedRevision: 0, idempotencyKey: 'so-act-base' });
    });

    it('取消（只預覽、不 apply）：active、run、設定版本都不變；預覽判為 with_students', () => {
      const before = { active: active(), runs: count('calculation_runs'), versions: count('settings_versions') };
      const prev = previewSettingsChange(db, undefined, { draft: draftWithAlias(), expectedRevision: 1 });
      expect(prev.mode).toBe('with_students');
      expect(prev.affectedStudents).toBe(13);
      expect({ active: active(), runs: count('calculation_runs'), versions: count('settings_versions') }).toEqual(before);
    });

    it('失敗（交易中途拋錯）：整筆 rollback——不留設定版本、不換 active、不記冪等；之後可正常重試', () => {
      const prev = previewSettingsChange(db, undefined, { draft: draftWithAlias(), expectedRevision: 1 });
      const before = { active: active(), runs: count('calculation_runs'), versions: count('settings_versions'), idem: count('idempotency_records') };

      // 讓重算失敗：預覽後名單學生資料消失 → executeCalculationRun 於交易內拋錯
      db.prepare('DELETE FROM student_enrollments WHERE import_id = ?').run(importA);
      db.prepare('DELETE FROM imported_students WHERE import_id = ?').run(importA);

      expect(() =>
        applySettingsPreview(db, { previewId: prev.previewId, expectedRevision: 1, idempotencyKey: 'so-fail-1' })
      ).toThrow();
      expect({ active: active(), runs: count('calculation_runs'), versions: count('settings_versions'), idem: count('idempotency_records') }).toEqual(before);
    });

    it('成功：新設定版本＋新 run 原子切換（active_run_id、revision 同步），舊 run 原封不動', () => {
      const oldRunId = active().active_run_id!;
      const oldSnapshot = JSON.stringify(db.prepare('SELECT * FROM calculation_runs WHERE id = ?').get(oldRunId));
      const { applied } = saveSettingsOnly(1, 'so-ok-1');

      expect(applied.runId).not.toBeNull();
      expect(applied.revision).toBe(2);
      expect(active()).toEqual({ active_import_id: importA, active_run_id: applied.runId, revision: 2 });
      expect(getCalculationRun(db, applied.runId!)!.scheduleVersionId).toBe(applied.settingsVersionId);
      // Single current state: older run is pruned
      expect(db.prepare('SELECT * FROM calculation_runs WHERE id = ?').get(oldRunId)).toBeUndefined();
    });
  });

  describe('UX04：settings_only 儲存與另一個 tab activate 競爭——一成功另一 409', () => {
    it('activate 先成功：settings_only 的 apply 因 revision 已推進而 409，不寫設定版本、不改 active', () => {
      const ready = saveBatch('imp_so_race1');
      const prev = previewSettingsChange(db, undefined, { draft: draftWithAlias(), expectedRevision: 0 });

      const act = activateImport(db, { importId: ready, expectedRevision: 0, idempotencyKey: 'so-race-act' });
      const stateAfterActivate = active();

      let caught: unknown;
      try {
        applySettingsPreview(db, { previewId: prev.previewId, expectedRevision: 0, idempotencyKey: 'so-race-apply' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SettingsApplyError);
      expect(caught).toMatchObject({ statusCode: 409, code: 'REVISION_CONFLICT' });
      expect(count('settings_versions')).toBe(0);
      expect(active()).toEqual(stateAfterActivate);
      expect(active().active_run_id).toBe(act.runId);
    });

    it('settings_only 先成功：activate 因 revision 已推進而 409，不建 run、不啟用 ready', () => {
      const ready = saveBatch('imp_so_race2');
      saveSettingsOnly(0, 'so-race2-save');
      expect(active().revision).toBe(1);

      expect(() => activateImport(db, { importId: ready, expectedRevision: 0, idempotencyKey: 'so-race2-act' })).toThrow(
        ActivateConflictError
      );
      expect(count('calculation_runs')).toBe(0);
      expect(active()).toEqual({ active_import_id: null, active_run_id: null, revision: 1 });
    });

    it('settings_only 預覽在 apply 時遇到「已有現行名單」但 revision 相同（竄改／異常狀態）：409 IMPORT_MISMATCH，不寫設定版本', () => {
      const ready = saveBatch('imp_so_forge');
      const draft = draftWithAlias();
      const now = new Date();
      saveSettingsPreview(db, {
        previewId: 'setprev_forged_so',
        inputHash: hashSettingsDraft(draft),
        draftJson: JSON.stringify(draft),
        expectedRevision: 0,
        settingsVersionId: 'seed-v250922',
        importId: null,
        resultJson: '{}',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      });
      // 異常狀態：有 active import，但 revision 仍是 0（正常流程不可能，activate 會遞增）
      db.prepare('UPDATE active_state SET active_import_id = ? WHERE id = 1').run(ready);

      let caught: unknown;
      try {
        applySettingsPreview(db, { previewId: 'setprev_forged_so', expectedRevision: 0, idempotencyKey: 'so-forge-1' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toMatchObject({ statusCode: 409, code: 'IMPORT_MISMATCH' });
      expect(count('settings_versions')).toBe(0);
    });

    it('同 key／同 body 成功重送回原結果；同 key 異 body 拒絕（IDEMPOTENCY_CONFLICT）', () => {
      const { prev, applied } = saveSettingsOnly(0, 'so-idem-1');
      expect(applySettingsPreview(db, { previewId: prev.previewId, expectedRevision: 0, idempotencyKey: 'so-idem-1' })).toEqual(applied);
      expect(() =>
        applySettingsPreview(db, { previewId: prev.previewId, expectedRevision: 5, idempotencyKey: 'so-idem-1' })
      ).toThrowError(expect.objectContaining({ statusCode: 400, code: 'IDEMPOTENCY_CONFLICT' }));
    });
  });
});

describe('settings_only：HTTP route（preview／apply）', () => {
  let tempDir: string;

  const req = (route: 'preview' | 'apply', body: unknown) =>
    new NextRequest(`http://127.0.0.1:3000/api/v1/settings/${route}`, {
      method: 'POST',
      headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-so-route-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    (global as any).__sqlite_db__ = undefined;
  });

  afterEach(() => {
    if ((global as any).__sqlite_db__) {
      (global as any).__sqlite_db__.close();
      (global as any).__sqlite_db__ = undefined;
    }
    delete process.env.DATABASE_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('空 DB：POST preview（不帶 importId）→ 200 settings_only；POST apply → 200 runId null；revision 遞增', async () => {
    const db = getDatabase() as any;
    const pres = await previewPOST(req('preview', { draft: draftWithAlias(), expectedRevision: 0 }));
    expect(pres.status).toBe(200);
    const prev = await pres.json();
    expect(prev.mode).toBe('settings_only');
    expect(prev.affectedStudents).toBeNull();

    const ares = await applyPOST(req('apply', { previewId: prev.previewId, expectedRevision: 0, idempotencyKey: 'so-route-1' }));
    expect(ares.status).toBe(200);
    const applied = await ares.json();
    expect(applied.runId).toBeNull();
    expect(applied.revision).toBe(1);
    const st = db.prepare('SELECT active_import_id, active_run_id, revision FROM active_state WHERE id = 1').get();
    expect(st).toEqual({ active_import_id: null, active_run_id: null, revision: 1 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM calculation_runs').get() as any).n).toBe(0);
  });

  it('client 以 null 表示無名單且確無現行名單：一致，走 settings_only（200）', async () => {
    getDatabase();
    const res = await previewPOST(req('preview', { importId: null, draft: draftWithAlias(), expectedRevision: 0 }));
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe('settings_only');
  });
});
