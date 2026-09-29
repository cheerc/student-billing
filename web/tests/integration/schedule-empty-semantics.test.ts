import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport } from '@/application/activate-import';
import { executeCalculationRun } from '@/application/calculate-run';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import {
  buildSeedDraft,
  draftToAliasMap,
  draftToScheduleOverride,
} from '@/adapters/sqlite/settings-repository';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { buildSchedulePreview } from '@/application/schedule-preview';
import {
  buildSeedGridRows,
  gridRowsToClasses,
  SettingsDraft,
} from '@/contracts/settings';

/**
 * 09 §8.2.4（方案 A）／04 §8 UX23：空時段與整班移除語意。
 * 存在已儲存設定版本時，班級與時段的唯一來源是該版本的全量 draft（D25），seed 只作「尚無任何
 * 已儲存設定」的初始值：
 * - 班級存在但 sessions 為空（含刪光時段、清空所有列時間）＝無時段：不扣天、SCHEDULE_EMPTY，不退回 seed；
 * - 班級不在該版本（整班移除）＝無此班：SCHEDULE_NOT_FOUND，不退回 seed。
 *
 * expected 皆獨立推得，不取自待測輸出：
 * - 基準＝「尚無已儲存設定、且 ERP 名單的『國小數學-一』不在 seed」的 seed run：該 13 位（D18）的數學班解不到
 *   時段，不扣天。凡「一A 無時段」或「一A 不在版本」，其安親天數必與基準逐人相同（沒有任何時段可扣）。
 * - 對照組：seed 全量 draft＋alias 一→一A → 13 位各扣 0.5 天（D18，既有已確認案例），證明測試確實能偵測到
 *   「退回 seed 一A 時段」這個缺陷。
 */

const ALIAS = { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' };
const CLASS_1A = '國小數學-一A';

function seedDraftWithAlias(): SettingsDraft {
  return { ...buildSeedDraft(), aliases: [ALIAS] };
}

/** 一A 保留為 active 班級，但 sessions 為空（刪光全部時段）。 */
function draftEmptiedClass(): SettingsDraft {
  const d = seedDraftWithAlias();
  return { ...d, classes: d.classes.map((c) => (c.baseName === CLASS_1A ? { ...c, sessions: [] } : c)) };
}

/** 整班移除：draft 完全沒有 一A 這個班。 */
function draftRemovedClass(): SettingsDraft {
  const d = seedDraftWithAlias();
  return { ...d, classes: d.classes.filter((c) => c.baseName !== CLASS_1A) };
}

/** 清空所有列時間：走既有的平鋪列→班級轉換（缺起訖的列不產出 session）。 */
function draftClearedRowTimes(): SettingsDraft {
  const rows = buildSeedGridRows().map((r) =>
    r.className === CLASS_1A ? { ...r, startTime: '', endTime: '', startMinutes: null, endMinutes: null } : r
  );
  const seed = seedDraftWithAlias();
  return { ...seed, classes: gridRowsToClasses(rows, seed.classes) };
}

interface DayRow {
  anqin: number | null;
  tutoring: number | null;
}

describe('UX23：空時段與整班移除（09 §8.2.4 方案 A）——run 計算', () => {
  let tempDir: string;
  let db: any;
  let importA: string;
  let math1Students: string[];
  let baseline: Map<string, DayRow>;

  function daysOf(results: Array<{ personCode: string; anqinDays: number | null; tutoringDays: number | null }>) {
    return new Map<string, DayRow>(results.map((r) => [r.personCode, { anqin: r.anqinDays, tutoring: r.tutoringDays }]));
  }

  function runWith(draft: SettingsDraft) {
    return executeCalculationRun(db, importA, `run_b4_${Math.random().toString(36).slice(2)}`, {
      aliasMap: draftToAliasMap(draft),
      scheduleOverride: draftToScheduleOverride(draft),
    });
  }

  function differing(days: Map<string, DayRow>): string[] {
    return [...days.entries()]
      .filter(([code, d]) => {
        const b = baseline.get(code)!;
        return d.anqin !== b.anqin || d.tutoring !== b.tutoring;
      })
      .map(([code]) => code);
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-b4-test-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);
    const buf = fs.readFileSync(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
    const preview = await generateImportPreview(buf, 'fixture.xlsx');
    importA = 'imp_b4_a';
    saveImportBatch(
      db,
      {
        id: importA,
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
    // D18：以報名資料界定受影響的 13 位（base_name＝國小數學-一），不取自計算結果
    math1Students = (
      db
        .prepare("SELECT DISTINCT person_code FROM student_enrollments WHERE import_id = ? AND base_name = '國小數學-一'")
        .all(importA) as Array<{ person_code: string }>
    ).map((r) => r.person_code);
    expect(math1Students).toHaveLength(13);

    baseline = daysOf(executeCalculationRun(db, importA, 'run_b4_baseline', {}).results);
  });

  afterEach(() => {
    if (db) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('對照組：seed 全量 draft＋alias 一→一A → 恰 13 位各扣 0.5 天（D18，已確認案例）', () => {
    const days = daysOf(runWith(seedDraftWithAlias()).results);
    const diff = differing(days);
    expect(diff.sort()).toEqual([...math1Students].sort());
    for (const code of diff) {
      const d = days.get(code)!;
      const b = baseline.get(code)!;
      expect((d.anqin ?? 0) - (b.anqin ?? 0)).toBeCloseTo(-0.5, 9);
    }
  });

  it('刪光一A 全部時段（班級仍 active、sessions=[]）：13 位不扣天，天數與基準逐人相同，且不退回 seed 一A 時段', () => {
    const { results } = runWith(draftEmptiedClass());
    expect(differing(daysOf(results))).toEqual([]);
  });

  it('刪光時段的 13 位：數學班解為 schedule_empty → tier 比較帶 SCHEDULE_EMPTY 且 needsReview，run 標有問題', () => {
    const { results } = runWith(draftEmptiedClass());
    const byCode = new Map(results.map((r) => [r.personCode, r]));
    for (const code of math1Students) {
      const r = byCode.get(code)!;
      const mathComp = r.tierComparisons.find((c) => c.baseName.includes('國小數學'))!;
      expect(mathComp.needsReview).toBe(true);
      expect(mathComp.issues).toContain('SCHEDULE_EMPTY');
      expect(r.hasIssues).toBe(true);
    }
  });

  it('清空一A 所有列時間（平鋪列→班級轉換後 sessions=[]）：與刪光時段同結果', () => {
    const draft = draftClearedRowTimes();
    expect(draft.classes.find((c) => c.baseName === CLASS_1A)?.sessions).toEqual([]);
    const { results } = runWith(draft);
    expect(differing(daysOf(results))).toEqual([]);
  });

  it('整班移除（draft 無一A）：13 位不扣天、帶 SCHEDULE_NOT_FOUND，且不退回 seed 一A 時段', () => {
    const { results } = runWith(draftRemovedClass());
    expect(differing(daysOf(results))).toEqual([]);
    const byCode = new Map(results.map((r) => [r.personCode, r]));
    for (const code of math1Students) {
      const r = byCode.get(code)!;
      expect(r.issues.map((i) => i.code)).toContain('SCHEDULE_NOT_FOUND');
      const mathComp = r.tierComparisons.find((c) => c.baseName.includes('國小數學'))!;
      expect(mathComp.issues).toContain('SCHEDULE_NOT_FOUND');
    }
  });

  it('整班移除只影響該班：其他學生的 SCHEDULE_NOT_FOUND 有無與基準逐人相同', () => {
    const hasNotFound = (r: { issues: Array<{ code: string }> }) => r.issues.some((i) => i.code === 'SCHEDULE_NOT_FOUND');
    const base = new Map(
      executeCalculationRun(db, importA, 'run_b4_base_issues', {}).results.map((r) => [r.personCode, hasNotFound(r)])
    );
    const { results } = runWith(draftRemovedClass());
    for (const r of results) {
      if (math1Students.includes(r.personCode)) continue;
      expect(hasNotFound(r)).toBe(base.get(r.personCode));
    }
  });

  it('停用的班（active=false）與刪光時段結果一致：都不扣天、都是 schedule_empty', () => {
    const d = seedDraftWithAlias();
    const inactive: SettingsDraft = {
      ...d,
      classes: d.classes.map((c) => (c.baseName === CLASS_1A ? { ...c, active: false } : c)),
    };
    const a = daysOf(runWith(inactive).results);
    const b = daysOf(runWith(draftEmptiedClass()).results);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('尚無已儲存設定（未帶 scheduleOverride）：seed 課表路徑不變——國小數學-一 不在 seed，13 位解不到時段（SCHEDULE_NOT_FOUND 13）', () => {
    const { run } = executeCalculationRun(db, importA, 'run_b4_seedpath', {});
    expect(run.issueCounts['SCHEDULE_NOT_FOUND']).toBe(13);
  });

  it('經 preview→apply 持久化：run 天數同樣不退回 seed，run.scheduleVersionId 為新設定版本', () => {
    activateImport(db, { importId: importA, expectedRevision: 0, idempotencyKey: 'b4-act' });
    const draft = draftEmptiedClass();
    const prev = previewSettingsChange(db, undefined, { draft, expectedRevision: 1 });
    const applied = applySettingsPreview(db, {
      previewId: prev.previewId,
      expectedRevision: 1,
      idempotencyKey: 'b4-apply',
    });
    const rows = db
      .prepare('SELECT person_code, anqin_days, tutoring_days FROM student_calculations WHERE run_id = ?')
      .all(applied.runId!) as Array<{ person_code: string; anqin_days: number | null; tutoring_days: number | null }>;
    const days = new Map<string, DayRow>(rows.map((r) => [r.person_code, { anqin: r.anqin_days, tutoring: r.tutoring_days }]));
    expect(differing(days)).toEqual([]);
    expect(getCalculationRun(db, applied.runId!)!.scheduleVersionId).toBe(applied.settingsVersionId);
  });
  it('三者一致（逐堂預覽／班級扣天／學生 run）：對照組——一A 有時段：班級實扣 −0.5 ＝ 13 位學生各 −0.5', () => {
    const draft = seedDraftWithAlias();
    const preview = buildSchedulePreview(draft, 'erp-tag-v2');
    const c = preview.classes.find((k) => k.classKey === CLASS_1A)!;
    expect(c.anqin.rounded).toBe(-0.5);
    const days = daysOf(runWith(draft).results);
    for (const code of math1Students) {
      expect((days.get(code)!.anqin ?? 0) - (baseline.get(code)!.anqin ?? 0)).toBeCloseTo(c.anqin.rounded, 9);
    }
  });

  it('三者一致：刪光時段——逐堂預覽回一列 null 佔位＋SCHEDULE_EMPTY；班級 0／missing_time；學生 run 不扣天且帶 SCHEDULE_EMPTY', () => {
    const draft = draftEmptiedClass();
    const preview = buildSchedulePreview(draft, 'erp-tag-v2');
    const rows = preview.rows.filter((r) => r.classKey === CLASS_1A);
    expect(rows).toHaveLength(1);
    expect(rows[0].anqin.overlapMinutes).toBeNull();
    const c = preview.classes.find((k) => k.classKey === CLASS_1A)!;
    expect([c.anqin.rounded, c.anqin.status]).toEqual([0, 'missing_time']);
    expect(preview.issues).toContainEqual(expect.objectContaining({ code: 'SCHEDULE_EMPTY', classKey: CLASS_1A }));

    const { results } = runWith(draft);
    expect(differing(daysOf(results))).toEqual([]);
    const byCode = new Map(results.map((r) => [r.personCode, r]));
    for (const code of math1Students) {
      const mathComp = byCode.get(code)!.tierComparisons.find((k) => k.baseName.includes('國小數學'))!;
      expect(mathComp.issues).toContain('SCHEDULE_EMPTY');
    }
  });

  it('三者一致：整班移除——逐堂預覽與班級表都沒有該班；學生 run 落 SCHEDULE_NOT_FOUND 且不扣天（不退回 seed）', () => {
    const draft = draftRemovedClass();
    const preview = buildSchedulePreview(draft, 'erp-tag-v2');
    expect(preview.classes.some((k) => k.classKey === CLASS_1A)).toBe(false);
    expect(preview.rows.some((r) => r.classKey === CLASS_1A)).toBe(false);

    const { results } = runWith(draft);
    expect(differing(daysOf(results))).toEqual([]);
    const byCode = new Map(results.map((r) => [r.personCode, r]));
    for (const code of math1Students) {
      expect(byCode.get(code)!.issues.map((i) => i.code)).toContain('SCHEDULE_NOT_FOUND');
    }
  });
});
