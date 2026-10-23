import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport } from '@/application/activate-import';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { SEED_CLASSES } from '@/domain/schedules/seed-manifest';
import { buildSeedDraft, hashSettingsDraft, saveSettingsVersion } from '@/adapters/sqlite/settings-repository';
import { queryRunStudents } from '@/application/query-students';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { migrateLegacyClassSemantics } from '@/domain/classification/legacy-semantic-migration';

/**
 * 全量 seed draft＋別名（D25：draft 攜全量；09 §8.2.4 方案 A 後 sessions 為空＝無時段，
 * 不再是「沿用 seed」，故測試 draft 必須攜 seed 明確時段）。
 */
let legacyMigratedDraft = buildSeedDraft();

function buildDraftWithAlias(extraAliases: Array<{ rawBaseName: string; targetBaseName: string }>) {
  return { ...legacyMigratedDraft, aliases: extraAliases };
}

describe('T05: preview→apply 雙階段流程整合測試 (I10/I11/I15/I18/I20)', () => {
  let tempDir: string;
  let tempDbPath: string;
  let db: any;
  let previewId: string;
  let activeRunId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-t05-test-'));
    tempDbPath = path.join(tempDir, 'test.sqlite');
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

    // The v4 characterization assumes the operator has accepted the one-time semantic migration.
    // Preserve only historical summary/tier interpretation for roster-only names; keep category
    // unset and the names unmapped so #157 behavior is unchanged.
    const seedDraft = buildSeedDraft();
    const configuredNames = new Set(seedDraft.classes.map((item) => item.baseName));
    const legacyNames = new Set(preview.students.flatMap((student) => student.enrollments.map((item) => item.baseName)));
    const candidates = new Map([...legacyNames]
      .filter((baseName) => !configuredNames.has(baseName) && !SEED_CLASSES.some((item) => item.baseName === baseName))
      .map((baseName) => [baseName, {
        baseName,
        migrateSummaryDayRoles: true,
        migrateErpTierApplicability: true,
      }]));
    const migrated = migrateLegacyClassSemantics(seedDraft.classes, candidates);
    const migratedDraft = { ...seedDraft, classes: migrated.classes };
    legacyMigratedDraft = migratedDraft;
    saveSettingsVersion(db, {
      id: 'legacy-migration-test',
      contentHash: hashSettingsDraft(migratedDraft),
      contentJson: JSON.stringify(migratedDraft),
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: new Date().toISOString(),
      createdFromPreviewId: null,
      revision: 1,
    });

    const act = activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: `t05-setup-${Date.now()}-${Math.random()}`,
    });
    activeRunId = act.runId;
  });

  afterEach(() => {
    if (db) db.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('I18: 數學一→一A dry-run 展示 13 人各 -0.5 天、mismatch 5→18', () => {
    const draft = buildDraftWithAlias([
      { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' },
    ]);
    const res = previewSettingsChange(db, previewId, { draft, expectedRevision: 1 });

    expect(res.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(res.previewId).toBeDefined();
    // 13 人受影響
    expect(res.affectedStudents).toBe(13);
    // 13 人各 -0.5 天
    expect(res.dayDeltas).toHaveLength(13);
    for (const d of res.dayDeltas!) {
      expect(d.after).toBe(d.before! - 0.5);
    }
    // mismatch 5→18
    expect(res.mismatchBefore).toBe(5);
    expect(res.mismatchAfter).toBe(18);
  });

  it('requires clearing an unsupported legacy fixedFiveDays value before saving a new settings version', () => {
    const draft = { ...buildSeedDraft(), classTypeDefinitions: undefined };
    const mathClass = draft.classes.find((item) => item.baseName === '國小數學-一A')!;
    mathClass.classType = 'non_care';
    mathClass.fixedFiveDays = true;

    expect(() => previewSettingsChange(db, previewId, { draft, expectedRevision: 1 }))
      .toThrow('設定草稿格式錯誤');
  });

  it('I18: 取消草稿不改 active；I11: 版本變更回 409', () => {
    const draft = buildDraftWithAlias([
      { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' },
    ]);
    // 僅 preview（dry-run），active 不變
    previewSettingsChange(db, previewId, { draft, expectedRevision: 1 });
    const active = db.prepare('SELECT revision, active_run_id FROM active_state WHERE id = 1').get() as any;
    expect(active.revision).toBe(1);
    expect(active.active_run_id).toBe(activeRunId);

    // 過期 revision 預覽應 409
    expect(() =>
      previewSettingsChange(db, previewId, { draft, expectedRevision: 0 })
    ).toThrowError(/版本衝突/);

    // 不存在的 previewId 套用應 404
    expect(() =>
      applySettingsPreview(db, {
        previewId: 'setprev_nonexistent',
        expectedRevision: 1,
        idempotencyKey: 'k-404',
      })
    ).toThrowError(/找不到設定預覽/);
  });

  it('B1: apply 成功後同 key＋同 body 重送應回原結果（冪等先於 409）', () => {
    const draft = buildDraftWithAlias([
      { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' },
    ]);
    const prev = previewSettingsChange(db, previewId, { draft, expectedRevision: 1 });
    const first = applySettingsPreview(db, {
      previewId: prev.previewId,
      expectedRevision: 1,
      idempotencyKey: 't05-b1-idemp',
    });
    expect(first.revision).toBe(2);

    // revision 已前進至 2；同 key＋同 body 重送必須回原結果而非 409
    const replay = applySettingsPreview(db, {
      previewId: prev.previewId,
      expectedRevision: 1,
      idempotencyKey: 't05-b1-idemp',
    });
    expect(replay.runId).toBe(first.runId);
    expect(replay.revision).toBe(first.revision);
  });

  it('N1: 同 key＋異 body 重送應拒絕（不靜默回放）', () => {    const draft = buildDraftWithAlias([
      { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' },
    ]);
    // 同 revision 下先建兩個不同 preview（異 body）
    const prev = previewSettingsChange(db, previewId, { draft, expectedRevision: 1 });
    const prev2 = previewSettingsChange(db, previewId, { draft, expectedRevision: 1 });
    expect(prev2.previewId).not.toBe(prev.previewId);

    applySettingsPreview(db, {
      previewId: prev.previewId,
      expectedRevision: 1,
      idempotencyKey: 't05-n1-idemp',
    });

    // 同 key 但不同 previewId（異 body）→ 必須拒絕而非回放
    expect(() =>
      applySettingsPreview(db, {
        previewId: prev2.previewId,
        expectedRevision: 1,
        idempotencyKey: 't05-n1-idemp',
      })
    ).toThrowError(/已被使用於不同的請求內容/);
  });

  it('I10/I20: apply 封存快照＋重算新 run；舊 run 可查且不受污染；離班保留', () => {
    const draft = buildDraftWithAlias([
      { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' },
    ]);
    const prev = previewSettingsChange(db, previewId, { draft, expectedRevision: 1 });
    const applied = applySettingsPreview(db, {
      previewId: prev.previewId,
      expectedRevision: 1,
      idempotencyKey: 't05-apply-1',
    });

    expect(applied.revision).toBe(2);
    expect(applied.mismatchCount).toBe(18);
    expect(applied.totalStudents).toBe(477);

    // 舊 run 仍可查且維持 5 mismatch
    const oldRun = getCalculationRun(db, activeRunId);
    expect(oldRun).toBeDefined();
    const oldStudents = queryRunStudents(db, activeRunId, { tierMismatch: true, limit: 100 });
    expect(oldStudents.totalStudents).toBe(5);

    // 新 run 為 18 mismatch
    const newStudents = queryRunStudents(db, applied.runId!, { tierMismatch: true, limit: 100 });
    expect(newStudents.totalStudents).toBe(18);

    // 離班學生仍保留（37 tokens 對應學生數不變）
    const newAll = queryRunStudents(db, applied.runId!, { limit: 200 });
    expect(newAll.stats.totalStudents).toBe(477);
  });

  it('I15: 新增班級／停用班級／變更老師草稿可預覽且不污染既有 run', () => {
    const draft = buildDraftWithAlias([]);
    (draft.classes as any[]).push({
      baseName: '測試新班-體驗課',
      subject: '其他',
      classTypeId: 'non_care',
      classType: 'non_care',
      subjectSource: 'unset',
      summaryDayRoles: [],
      summaryDayRolesStatus: 'unset',
      summaryDayRolesSource: 'unset',
      erpTierApplicability: 'unset',
      erpTierApplicabilitySource: 'unset',
      teacher: '測試老師',
      active: true,
      sessions: [{ weekday: '一', startMinutes: 780, endMinutes: 840 }],
    });
    const target = (draft.classes as any[]).find((c) => c.baseName === '國小數學-一A');
    target.teacher = '新老師';
    const targetB = (draft.classes as any[]).find((c) => c.baseName === '國小數學-一B');
    targetB.active = false;

    const res = previewSettingsChange(db, previewId, { draft, expectedRevision: 1 });
    expect(res.previewId).toBeDefined();
    expect(res.inputHash).toMatch(/^[a-f0-9]{64}$/);
    // 既有 run 不受影響
    const oldStudents = queryRunStudents(db, activeRunId, { tierMismatch: true, limit: 100 });
    expect(oldStudents.totalStudents).toBe(5);
  });

  it('F1/K4: 穩態 preview 使用已保存 active Run；沒有可比較的 Run 時 fail-closed', () => {
    // 態 A：有 active run（beforeEach 已 activate，active_run_id 存在）→ 跟隨該 run 版本
    const draftA = buildSeedDraft(SEED_CLASSES, {
      anqin: { start: 780, end: 960 },
      tutoring: { start: 990, end: 1170 },
    });
    let resA: any;
    expect(() => {
      resA = previewSettingsChange(db, previewId, { draft: draftA, expectedRevision: 1 });
    }).not.toThrow();
    expect(resA.previewId).toBeDefined();

    const activeRow = db.prepare('SELECT active_run_id FROM active_state WHERE id = 1').get() as any;
    expect(activeRow.active_run_id).toBe(activeRunId);
    const runRow = db.prepare('SELECT rule_set_version FROM calculation_runs WHERE id = ?').get(activeRunId) as any;
    expect(runRow.rule_set_version).toBeDefined();

    // 態 B：沒有 active run 就沒有可作為 before 的保存結果，不能合成預覽前值。
    db.prepare('UPDATE active_state SET active_run_id = NULL WHERE id = 1').run();
    const draftB = buildSeedDraft(SEED_CLASSES, {
      anqin: { start: 780, end: 960 },
      tutoring: { start: 990, end: 1170 },
    });
    expect(() => previewSettingsChange(db, previewId, { draft: draftB, expectedRevision: 1 }))
      .toThrowError(/沒有可供比較的已保存 Run/);
  });
});
