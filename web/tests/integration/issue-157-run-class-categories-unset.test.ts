import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { executeCalculationRun } from '@/application/calculate-run';
import { loadRunClassCategories } from '@/application/applicable-rate';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import type { ClassSettingLookup } from '@/domain/classification/class-category';

/**
 * Issue #157 PR-1 Ruling 3：`run_class_categories` 快照的 `category` 值域新增 `unset`，
 * 且**未對應的班一律寫 `unset`**（不論班名為何），`source` 值域由 `'auto' | 'manual'`
 * 改為 `'manual' | 'unset'`（Migration 0007 的欄位為 TEXT，不需 schema migration，
 * 契約見 specs/03 §5.3.4）。
 *
 * 走完整生產呼叫鏈：`executeCalculationRun` → `saveCalculationRun`（寫入點唯一），
 * 再從讀模型 `loadRunClassCategories` 取回，確保斷言落在實際會持久化的內容上。
 */
describe('Issue #157 快照：未對應班 category=unset、source=unset', () => {
  let db: Database.Database;

  /** 名冊同時涵蓋「未對應」與「已對應但未指定類別」兩種班。 */
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    const now = new Date().toISOString();
    saveImportBatch(
      db,
      {
        id: 'imp_157',
        fileName: 'synth.xlsx',
        fileHash: 'h157',
        contentHash: 'c157',
        sheetName: 'Sheet1',
        headerMap: {},
        parserVersion: '1.0.0',
        scopeNote: '',
        rowCount: 1,
        status: 'ready',
        createdAt: now,
      },
      [
        {
          personCode: 'S157',
          name: '合成學生',
          grade: 4,
          gradeRaw: '4',
          gradeStatus: 'valid',
          branch: '本部',
          contact: null,
          schoolInfo: null,
          tagsRaw: '',
          tags: [],
          notesRaw: '',
          sourceRow: 1,
          enrollments: [
            // 未對應（課表設定沒有這個班名）——四種舊制會被偵測成不同類別的寫法
            ['國小輔導-未對應班', '國小數學-未對應班', '兒童美語-未對應班', '交通車-未對應班'].map((baseName) => ({
              rawToken: baseName,
              yearPrefix: null,
              baseName,
              groupFlag: null,
              modifiers: [],
              withdrawalDate: null,
              erpBillingTierRaw: null,
              erpBillingTier: null,
              tierParseStatus: 'not_applicable' as const,
              parseStatus: 'ok' as const,
            })),
          ].flat(),
        },
      ]
    );
  });

  afterEach(() => db.close());

  function runV4(runId: string, classSettings?: Map<string, ClassSettingLookup>) {
    return executeCalculationRun(db, 'imp_157', runId, {
      ruleSetVersion: 'erp-tag-v4',
      classSettings,
    });
  }

  it('未對應班一律寫 category=unset、source=unset、mapped=0（不論班名為何）', () => {
    const res = runV4('run_157_unmapped');
    // 快照的唯一寫入點是 saveCalculationRun（D2c N-1），讀模型才查得到。
    saveCalculationRun(db, res.run, res.results, res.classCategories);
    const rows = loadRunClassCategories(db, 'run_157_unmapped');

    // executeCalculationRun 產出的快照物件與讀模型必須一致（同一組事實）
    expect(res.classCategories).toBeDefined();

    for (const baseName of [
      '國小輔導-未對應班',
      '國小數學-未對應班',
      '兒童美語-未對應班',
      '交通車-未對應班',
    ]) {
      // 讀模型（RunClassCategorySnapshot）只帶 base_name／category／fixed_five_days，
      // 因此 mapped 由 executeCalculationRun 產出的記錄驗證、category 兩者都驗。
      const row = rows.find((r) => r.base_name === baseName);
      expect(row, baseName).toBeDefined();
      expect(row!.category, baseName).toBe('unset');

      const record = res.classCategories!.find((r) => r.baseName === baseName);
      expect(record, baseName).toBeDefined();
      expect(record!.mapped, baseName).toBe(0);
      expect(record!.category, baseName).toBe('unset');
      expect(record!.source, baseName).toBe('unset');
    }
  });

  it('已對應但使用者未指定類別 → 快照 category=unset（不得依班名寫入 math）', () => {
    const classSettings = new Map<string, ClassSettingLookup>([
      ['國小數學-未對應班', {}], // 已收錄於課表設定，但沒有 category 欄位
    ]);
    const res = runV4('run_157_mapped_unset', classSettings);

    const record = res.classCategories!.find((r) => r.baseName === '國小數學-未對應班');
    expect(record!.mapped).toBe(1);
    expect(record!.category).toBe('unset');
    expect(record!.source).toBe('unset');
  });

  it('使用者明確指定類別 → 快照寫入該類別且 source=manual', () => {
    const classSettings = new Map<string, ClassSettingLookup>([
      ['國小輔導-未對應班', { category: 'care', categorySource: 'manual', fixedFiveDays: true }],
    ]);
    const res = runV4('run_157_manual', classSettings);

    const record = res.classCategories!.find((r) => r.baseName === '國小輔導-未對應班');
    expect(record!.category).toBe('care');
    expect(record!.source).toBe('manual');
    expect(record!.mapped).toBe(1);
    expect(record!.fixedFiveDays).toBe(1);
  });
});
