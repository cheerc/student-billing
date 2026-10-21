import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { executeCalculationRun } from '@/application/calculate-run';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import { previewSettingsChange } from '@/application/settings-preview';
import { buildSeedDraft, saveSettingsVersion } from '@/adapters/sqlite/settings-repository';
import type { SettingsDraft } from '@/contracts/settings';

function seedFourGradeStudent(db: Database.Database, importId: string) {
  const initialDraft = buildSeedDraft();
  const care = initialDraft.classes.find((c) => c.baseName === '國小輔導-四年級')!;
  care.fixedFiveDays = true;
  saveSettingsVersion(db, {
    id: 'setv_test',
    contentHash: 'h_test',
    contentJson: JSON.stringify(initialDraft),
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    createdAt: new Date().toISOString(),
    createdFromPreviewId: null,
    revision: 1,
  });

  saveImportBatch(
    db,
    {
      id: importId,
      fileName: 'test-roster.xlsx',
      fileHash: 'h-1',
      contentHash: 'c-1',
      sheetName: 'Sheet1',
      headerMap: {},
      parserVersion: '1.0.0',
      scopeNote: '',
      rowCount: 1,
      status: 'ready',
      createdAt: new Date().toISOString(),
    },
    [
      {
        personCode: 'S_FOURTH',
        name: '四年級生',
        grade: 4,
        gradeRaw: '四年級',
        gradeStatus: 'valid',
        branch: '本校',
        contact: null,
        schoolInfo: null,
        tagsRaw: '',
        tags: [],
        notesRaw: '',
        sourceRow: 1,
        enrollments: [
          {
            rawToken: '國小輔導-四年級[團]',
            yearPrefix: null,
            baseName: '國小輔導-四年級',
            groupFlag: '團',
            modifiers: [],
            withdrawalDate: null,
            erpBillingTierRaw: null,
            erpBillingTier: null,
            tierParseStatus: 'not_applicable',
            parseStatus: 'ok',
          },
          {
            rawToken: '國小數學-四A[團]',
            yearPrefix: null,
            baseName: '國小數學-四A',
            groupFlag: '團',
            modifiers: [],
            withdrawalDate: null,
            erpBillingTierRaw: null,
            erpBillingTier: null,
            tierParseStatus: 'not_applicable',
            parseStatus: 'ok',
          },
        ],
      },
    ] as any
  );
}

function activate(db: Database.Database, importId: string, runId: string, version: string = 'erp-tag-v3') {
  const classSettings = new Map([
    ['國小輔導-四年級', { category: 'care' as const, fixedFiveDays: true }],
    ['國小數學-四A', { category: 'math' as const, fixedFiveDays: false }],
  ]);
  const res = executeCalculationRun(db, importId, runId, { ruleSetVersion: version as any, classSettings });
  saveCalculationRun(db, res.run, res.results, res.classCategories);
  db.prepare('UPDATE active_state SET active_run_id = ?, active_import_id = ?, revision = 1 WHERE id = 1').run(runId, importId);
  return res;
}

describe('Ruling 2: settings-preview 納入課程學費折扣差異（courseRateDeltas 方案 a）', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedFourGradeStudent(db, 'imp_four');
    activate(db, 'imp_four', 'run_v3', 'erp-tag-v3');
  });

  afterEach(() => db.close());

  it('1. v3 升級至 v4 時：四年級「輔導（固定 5 天）+ 數學」天數/科數/合計折扣皆同，但課輔收費率由 10000 降為 9500 → courseRateDeltas 呈現且 affectedStudents=1', () => {
    const draft: SettingsDraft = buildSeedDraft();
    const care = draft.classes.find((c) => c.baseName === '國小輔導-四年級')!;
    care.fixedFiveDays = true; // 勾選固定 5 天

    const preview = previewSettingsChange(db, 'imp_four', {
      draft,
      expectedRevision: 1,
      targetRuleSetVersion: 'erp-tag-v4',
    });

    // 天數、科數、合計折扣皆無差異
    expect(preview.dayDeltas).toHaveLength(0);
    expect(preview.subjectCountDeltas).toHaveLength(0);
    expect(preview.baseDiscountDeltas).toHaveLength(0);

    // 第四類差異：courseRateDeltas 必須有課輔與安親項
    expect(preview.courseRateDeltas).toBeDefined();
    expect(preview.courseRateDeltas).toHaveLength(2);
    expect(preview.courseRateDeltas).toContainEqual({
      personCode: 'S_FOURTH',
      name: '四年級生',
      course: 'tutoring',
      courseLabel: '課輔',
      before: 10000,
      after: 9500,
    });
    expect(preview.courseRateDeltas).toContainEqual({
      personCode: 'S_FOURTH',
      name: '四年級生',
      course: 'anqin',
      courseLabel: '安親',
      before: 10000,
      after: 9500,
    });

    // 關鍵斷言：affectedStudents 必須為 1 人（不是 0 人！）
    expect(preview.affectedStudents).toBe(1);
  });

  it('2. 日常設定編輯（非升級）：在 v3 下切換固定 5 天亦會改變收費率 → courseRateDeltas 正常觸發', () => {
    const draft: SettingsDraft = buildSeedDraft();
    const care = draft.classes.find((c) => c.baseName === '國小輔導-四年級')!;
    // 已存設定為 true，編輯草稿取消勾選為 false
    care.fixedFiveDays = false;

    const preview = previewSettingsChange(db, 'imp_four', {
      draft,
      expectedRevision: 1,
      targetRuleSetVersion: 'erp-tag-v3', // 維持 v3
    });

    // 在 v3 下，取消固定 5 天會讓課輔收費率由 10000 回到 9500
    expect(preview.courseRateDeltas).toBeDefined();
    expect(preview.courseRateDeltas).toContainEqual({
      personCode: 'S_FOURTH',
      name: '四年級生',
      course: 'tutoring',
      courseLabel: '課輔',
      before: 10000,
      after: 9500,
    });
    expect(preview.affectedStudents).toBe(1);
  });

  it('3. settings_only 模式下：courseRateDeltas 與 affectedStudents 必須維持 null，不可為 [] 或 0', () => {
    const freshDb = new Database(':memory:');
    try {
      runMigrations(freshDb);
      const draft = buildSeedDraft();
      const preview = previewSettingsChange(freshDb, undefined, {
        draft,
        expectedRevision: 0,
      });

      expect(preview.mode).toBe('settings_only');
      expect(preview.affectedStudents).toBeNull();
      expect((preview as any).courseRateDeltas).toBeNull();
    } finally {
      freshDb.close();
    }
  });
});
