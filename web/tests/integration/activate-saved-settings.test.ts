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
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { POST as activatePOST } from '@/app/api/v1/imports/[previewId]/activate/route';

/**
 * Issue #24／04 §8 UX22／09 §8.2.1：
 * 每一次 activate 由 server 於同一交易內解析最新已儲存 settings version，
 * 套用其班名對應與時段，run.scheduleVersionId＝該版本 id；忽略 client 傳入的 scheduleVersionId；
 * 尚無任何已儲存設定才用 seed（seed-v250922）。
 *
 * expected 皆由規格／業務決策獨立手算，不取自待測 activate：
 * - D18：數學一班對一A，13 位學生受影響。
 * - D24：同班各時段重疊先加總成扣天量，小數部分 ≥0.8 扣 1.0、0.3–<0.8 扣 0.5。
 * - 一A 週四 13:30–16:30 對安親窗口 13:00–16:00 重疊 150 分 → 150÷180≈0.833 → 扣 1.0；
 *   課輔窗口 16:30–19:30 重疊 0（週六不與週一至五窗口比，D30）。
 * - R11：小一／小二安親天數＝max(3.5, 5＋科目扣天…)；故 seed 值 s 的學生新值為 max(3.5, s−1.0)
 *   （5 天→4；4 天→3.5，被 3.5 下限擋住）。
 * - 受影響學生以報名資料界定（base_name＝國小數學-一，D18 為 13 人），不取自計算結果。
 * 測試用完整 seed draft（每班都有明確時段），不依賴「空 sessions 退回 seed」的舊語意（R1b 範圍）。
 */

const SEED_VERSION = 'seed-v250922';
const CUSTOM_ALIAS = { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' };

type SeedDraft = ReturnType<typeof buildSeedDraft>;

/** 完整 seed draft＋班名對應（一→一A）＋一A 週四時段改為 13:30–16:30（其餘班級沿用 seed 明確時段）。 */
function buildSavedDraft(): SeedDraft {
  const seed = buildSeedDraft();
  const classes = seed.classes.map((c) =>
    c.baseName === '國小數學-一A'
      ? {
          ...c,
          sessions: [
            { weekday: '四', startMinutes: 810, endMinutes: 990 },
            { weekday: '六', startMinutes: 630, endMinutes: 720 },
          ],
        }
      : c
  );
  return { ...seed, classes, aliases: [CUSTOM_ALIAS] };
}

interface CalcRow {
  person_code: string;
  anqin_days: number | null;
  tutoring_days: number | null;
  tier_mismatch: number;
}

describe('Issue #24／UX22：activate 採最新已儲存設定（09 §8.2.1）', () => {
  let tempDir: string;
  let db: any;
  let preview: Awaited<ReturnType<typeof generateImportPreview>>;
  let importA: string;

  function saveBatch(suffix: string): string {
    const id = `imp_i24_${suffix}`;
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

  function calcRows(runId: string): CalcRow[] {
    return db
      .prepare(
        'SELECT person_code, anqin_days, tutoring_days, tier_mismatch FROM student_calculations WHERE run_id = ? ORDER BY person_code'
      )
      .all(runId) as CalcRow[];
  }

  function runSnapshot(runId: string): string {
    const run = db.prepare('SELECT * FROM calculation_runs WHERE id = ?').get(runId);
    return JSON.stringify({ run, rows: calcRows(runId) });
  }

  function saveSettings(importId: string, expectedRevision: number, draft: SeedDraft, key: string) {
    const prev = previewSettingsChange(db, importId, { draft, expectedRevision });
    return applySettingsPreview(db, { previewId: prev.previewId, expectedRevision, idempotencyKey: key });
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-i24-test-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);

    const buf = fs.readFileSync(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
    preview = await generateImportPreview(buf, 'fixture.xlsx');
    importA = saveBatch('a');
  });

  afterEach(() => {
    if (db) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('尚無任何已儲存設定：run.scheduleVersionId 維持 seed-v250922，client 傳入的 scheduleVersionId 被忽略', () => {
    const res = activateImport(db, {
      importId: importA,
      expectedRevision: 0,
      idempotencyKey: 'i24-seed-1',
      scheduleVersionId: 'client-fake-v1',
    } as any);

    expect(getCalculationRun(db, res.runId)!.scheduleVersionId).toBe(SEED_VERSION);
  });

  it('apply 自訂時段＋班名對應 → 匯入新批次 → activate：run 採最新已儲存設定，天數與對應皆套用（client scheduleVersionId 被忽略）', () => {
    // 基準：seed 設定下啟用批次 A（revision 0→1）
    const seedAct = activateImport(db, { importId: importA, expectedRevision: 0, idempotencyKey: 'i24-base' });
    const seedRows = calcRows(seedAct.runId);
    expect(seedRows).toHaveLength(477);

    // 設定頁 apply（revision 1→2）：含班名對應與自訂時段
    const applied = saveSettings(importA, 1, buildSavedDraft(), 'i24-apply-1');
    expect(applied.revision).toBe(2);
    const appliedRows = calcRows(applied.runId);

    const seedRunBefore = runSnapshot(seedAct.runId);
    const appliedRunBefore = runSnapshot(applied.runId);

    // 匯入新批次（與 A 同名單、不同 import id）並啟用；另帶不同的 client scheduleVersionId
    const importB = saveBatch('b');
    const act = activateImport(db, {
      importId: importB,
      expectedRevision: 2,
      idempotencyKey: 'i24-activate-b',
      scheduleVersionId: 'client-fake-v1',
    } as any);
    expect(act.revision).toBe(3);

    // 1) run 記錄的版本＝最新已儲存設定（apply 結果的 settingsVersionId），不是 seed、不是 client 值
    const run = getCalculationRun(db, act.runId)!;
    expect(run.scheduleVersionId).toBe(applied.settingsVersionId);
    expect(run.scheduleVersionId).not.toBe(SEED_VERSION);
    expect(run.scheduleVersionId).not.toBe('client-fake-v1');

    // 2) 天數採該設定：報名「國小數學-一」的 13 位（D18）安親＝max(3.5, seed−1.0)，課輔不變；其餘學生天數與 seed 基準相同
    const mathOne = new Set(
      (
        db
          .prepare('SELECT DISTINCT person_code FROM student_enrollments WHERE import_id = ? AND base_name = ?')
          .all(importB, '國小數學-一') as Array<{ person_code: string }>
      ).map((r) => r.person_code)
    );
    expect(mathOne.size).toBe(13);
    const rows = calcRows(act.runId);
    expect(rows).toHaveLength(477);
    const seedByCode = new Map(seedRows.map((r) => [r.person_code, r]));
    let fiveDayAnchors = 0;
    for (const r of rows) {
      const s = seedByCode.get(r.person_code)!;
      if (mathOne.has(r.person_code)) {
        expect(r.anqin_days).toBe(Math.max(3.5, s.anqin_days! - 1.0));
        expect(r.tutoring_days).toBe(s.tutoring_days);
        if (s.anqin_days === 5) {
          expect(r.anqin_days).toBe(4);
          fiveDayAnchors++;
        }
      } else {
        expect(r.anqin_days).toBe(s.anqin_days);
        expect(r.tutoring_days).toBe(s.tutoring_days);
      }
    }
    expect(fiveDayAnchors).toBeGreaterThan(0);

    // 3) 與 apply 路徑（同一份已儲存設定、同名單）逐人一致
    expect(rows).toEqual(appliedRows);

    // 4) 既有 run 不可變：seed run 與 apply run 的 run 列與逐人結果都不變
    expect(runSnapshot(seedAct.runId)).toBe(seedRunBefore);
    expect(runSnapshot(applied.runId)).toBe(appliedRunBefore);
  });

  it('每一次 activate 都取最新版：第二次 apply 後再匯入啟用，run 採第二版設定', () => {
    const seedAct = activateImport(db, { importId: importA, expectedRevision: 0, idempotencyKey: 'i24-latest-base' });
    const seedRows = calcRows(seedAct.runId);
    const first = saveSettings(importA, 1, buildSavedDraft(), 'i24-latest-apply-1');

    // 第二版：一A 撤回自訂時段（沿用 seed 時段：週四 15:00–16:30），仍保留班名對應
    const seedDraft = buildSeedDraft();
    const draft2 = buildSavedDraft();
    draft2.classes = draft2.classes.map((c) =>
      c.baseName === '國小數學-一A' ? seedDraft.classes.find((s) => s.baseName === c.baseName)! : c
    );
    const second = saveSettings(importA, first.revision, draft2, 'i24-latest-apply-2');
    expect(second.settingsVersionId).not.toBe(first.settingsVersionId);

    const importB = saveBatch('latest-b');
    const act = activateImport(db, {
      importId: importB,
      expectedRevision: second.revision,
      idempotencyKey: 'i24-latest-act',
    });

    expect(getCalculationRun(db, act.runId)!.scheduleVersionId).toBe(second.settingsVersionId);
    // 第二版一A 週四 15:00–16:30：安親重疊 60 分，60÷180≈0.333 → 扣 0.5（D18 的 13 人各 −0.5）；
    // 若誤採第一版會是 −1.0，若退回 seed 則不變。
    const seedByCode = new Map(seedRows.map((r) => [r.person_code, r]));
    const rows = calcRows(act.runId);
    const affected = rows.filter((r) => seedByCode.get(r.person_code)!.anqin_days !== r.anqin_days);
    expect(affected).toHaveLength(13);
    for (const r of affected) {
      expect(r.anqin_days).toBe(seedByCode.get(r.person_code)!.anqin_days! - 0.5);
    }
    expect(rows).toEqual(calcRows(second.runId));
  });

  it('冪等：同 key 同 body 回原結果；body 只差 client scheduleVersionId 時不視為不同請求（hash 不含它）', () => {
    activateImport(db, { importId: importA, expectedRevision: 0, idempotencyKey: 'i24-idem-base' });
    saveSettings(importA, 1, buildSavedDraft(), 'i24-idem-apply');
    const importB = saveBatch('idem-b');

    const first = activateImport(db, {
      importId: importB,
      expectedRevision: 2,
      idempotencyKey: 'i24-idem-key',
      scheduleVersionId: 'client-fake-v1',
    } as any);
    const runCount = () => (db.prepare('SELECT COUNT(*) AS n FROM calculation_runs').get() as any).n;
    const before = runCount();

    // 同 key、body 只差 scheduleVersionId：回原結果，不新增 run、不 400
    const replay = activateImport(db, {
      importId: importB,
      expectedRevision: 2,
      idempotencyKey: 'i24-idem-key',
      scheduleVersionId: 'client-fake-v2',
    } as any);
    expect(replay.runId).toBe(first.runId);
    expect(replay.revision).toBe(first.revision);
    expect(runCount()).toBe(before);

    // 同 key、省略 scheduleVersionId：同樣回原結果
    const replayNoField = activateImport(db, {
      importId: importB,
      expectedRevision: 2,
      idempotencyKey: 'i24-idem-key',
    });
    expect(replayNoField.runId).toBe(first.runId);

    // 同 key、實質不同 body（asOfDate 不同）仍拒絕
    expect(() =>
      activateImport(db, {
        importId: importB,
        expectedRevision: 2,
        idempotencyKey: 'i24-idem-key',
        asOfDate: '2026-01-01',
      })
    ).toThrowError(/已被使用於不同的請求內容/);
  });
});

function resetGlobalDb() {
  if (global.__sqlite_db__) {
    global.__sqlite_db__.close();
    global.__sqlite_db__ = undefined;
  }
}

describe('Issue #24／UX22：activate route 不轉交 client scheduleVersionId', () => {
  let tempDir: string;
  let importId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-i24-route-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    resetGlobalDb();
  });

  afterEach(() => {
    resetGlobalDb();
    delete process.env.DATABASE_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('HTTP activate 帶 client scheduleVersionId：run 仍採最新已儲存設定', async () => {
    const db = getDatabase() as any;
    const buf = fs.readFileSync(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
    const preview = await generateImportPreview(buf, 'fixture.xlsx');
    importId = 'imp_i24_route';
    saveImportBatch(
      db,
      {
        id: importId,
        fileName: 'fixture.xlsx',
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
    activateImport(db, { importId, expectedRevision: 0, idempotencyKey: 'i24-route-base' });
    const prev = previewSettingsChange(db, importId, { draft: buildSavedDraft(), expectedRevision: 1 });
    const applied = applySettingsPreview(db, {
      previewId: prev.previewId,
      expectedRevision: 1,
      idempotencyKey: 'i24-route-apply',
    });

    const importB = 'imp_i24_route_b';
    saveImportBatch(
      db,
      {
        id: importB,
        fileName: 'fixture-b.xlsx',
        fileHash: `${preview.fileHash}-b`,
        contentHash: `${preview.contentHash}-b`,
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

    const req = new NextRequest(`http://127.0.0.1:3000/api/v1/imports/${importB}/activate`, {
      method: 'POST',
      headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
      body: JSON.stringify({
        expectedRevision: applied.revision,
        idempotencyKey: 'i24-route-act',
        scheduleVersionId: 'client-fake-v1',
      }),
    });
    const res = await activatePOST(req, { params: Promise.resolve({ previewId: importB }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(getCalculationRun(db, body.runId)!.scheduleVersionId).toBe(applied.settingsVersionId);
  });
});
