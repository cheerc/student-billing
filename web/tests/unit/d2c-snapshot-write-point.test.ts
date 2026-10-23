import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { executeCalculationRun } from '@/application/calculate-run';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';

/**
 * D2c 移交項閉環（N-1，D2a secondary r2／D2b r2 primary N-1）：
 * 快照寫入點必須**唯一**。
 *
 * 移除前：`calculate-run.ts` 有一段「若 calculation_runs 在呼叫前已存在（例如測試中先建好 run），
 * 補寫快照」的分支，與 `saveCalculationRun` 的正式寫入並行——寫入點不唯一，且該分支
 * 只為測試而存在。移除後快照只由 `saveCalculationRun` 寫入。
 *
 * 斷言方式：**不讀原始碼字串**（那會是實作細節的鏡像），而是觀察可觀察行為——
 * 在 run 列已存在時呼叫 `executeCalculationRun`，`run_class_categories` 不得被寫入。
 */
describe('D2c N-1：快照寫入點唯一（executeCalculationRun 不寫 run_class_categories）', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const now = new Date().toISOString();
    saveImportBatch(
      db,
      {
        id: 'imp_n1',
        fileName: 'n1.xlsx',
        fileHash: 'h',
        contentHash: 'c',
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
          personCode: 'N1000',
          name: '合成學生',
          grade: 4,
          gradeRaw: '4',
          gradeStatus: 'valid' as const,
          branch: '本部',
          contact: null,
          schoolInfo: null,
          tagsRaw: '',
          tags: [],
          notesRaw: '',
          sourceRow: 1,
          enrollments: [
            {
              rawToken: '國小輔導-四年級',
              yearPrefix: null,
              baseName: '國小輔導-四年級',
              groupFlag: null,
              modifiers: [],
              withdrawalDate: null,
              erpBillingTierRaw: null,
              erpBillingTier: null,
              tierParseStatus: 'not_applicable' as const,
              parseStatus: 'ok' as const,
            },
          ],
        },
      ]
    );
  });

  afterEach(() => db.close());

  const categoryRows = (runId: string) =>
    db.prepare('SELECT * FROM run_class_categories WHERE run_id = ?').all(runId) as unknown[];

  it('run 列已存在時，executeCalculationRun 不得寫入快照（寫入只由 saveCalculationRun 負責）', () => {
    // 先建立 run 列（模擬舊測試「先建好 run」的做法）
    db.prepare(`
      INSERT INTO calculation_runs (id, import_id, schedule_version_id, rule_set_version, numeric_policy, as_of_date, status, issue_counts, total_students, created_at)
      VALUES ('run_pre', 'imp_n1', 'seed-v1', 'erp-tag-v3', 'integer-minute-rational-v1', '2026-01-01', 'completed', '{}', 1, '2026-01-01T00:00:00.000Z')
    `).run();
    expect(categoryRows('run_pre')).toHaveLength(0);

    const res = executeCalculationRun(db, 'imp_n1', 'run_pre', { ruleSetVersion: 'erp-tag-v4' });

    // 計算結果仍帶著快照（呼叫端契約未變）
    expect((res.classCategories ?? []).length).toBeGreaterThan(0);
    // 但**不寫入** DB：寫入點唯一
    expect(categoryRows('run_pre')).toHaveLength(0);
  });

  it('run 列不存在時，executeCalculationRun 也不寫入（該分支一律不生效）', () => {
    const res = executeCalculationRun(db, 'imp_n1', 'run_absent', { ruleSetVersion: 'erp-tag-v4' });
    expect((res.classCategories ?? []).length).toBeGreaterThan(0);
    expect(categoryRows('run_absent')).toHaveLength(0);
  });

  it('唯一寫入點 saveCalculationRun：走完整生產呼叫鏈後快照存在', () => {
    const res = executeCalculationRun(db, 'imp_n1', 'run_prod', { ruleSetVersion: 'erp-tag-v4' });
    saveCalculationRun(db, res.run, res.results, res.classCategories, res.classSemantics);
    expect(categoryRows('run_prod').length).toBeGreaterThan(0);
  });
});
