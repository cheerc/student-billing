import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { executeCalculationRun } from '@/application/calculate-run';
import { applicableRateForClass } from '@/application/applicable-rate';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';

describe('D2a: run_class_categories 快照持久化與讀模型', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    const now = new Date().toISOString();
    saveImportBatch(
      db,
      {
        id: 'imp_test',
        fileName: 'test.xlsx',
        fileHash: 'hash_test',
        contentHash: 'hash_test',
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
          personCode: 'S001',
          name: '測試生',
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
            {
              rawToken: '國小輔導-寫功課',
              yearPrefix: null,
              baseName: '國小輔導-寫功課',
              groupFlag: null,
              modifiers: [],
              withdrawalDate: null,
              erpBillingTierRaw: null,
              erpBillingTier: null,
              tierParseStatus: 'not_applicable',
              parseStatus: 'ok',
            },
            {
              rawToken: '國小輔導-四年級',
              yearPrefix: null,
              baseName: '國小輔導-四年級',
              groupFlag: null,
              modifiers: [],
              withdrawalDate: null,
              erpBillingTierRaw: null,
              erpBillingTier: null,
              tierParseStatus: 'not_applicable',
              parseStatus: 'ok',
            },
          ],
        },
      ]
    );
  });

  afterEach(() => {
    db.close();
  });

  it('erp-tag-v3 run 會寫入 run_class_categories，且在 saveCalculationRun (生產呼叫鏈) 後不被級聯刪除 (R2-1)', () => {
    // 1. 執行 v2 run 並走生產 saveCalculationRun
    const resV2 = executeCalculationRun(db, 'imp_test', 'run_v2', {
      ruleSetVersion: 'erp-tag-v2',
    });
    saveCalculationRun(db, resV2.run, resV2.results, (resV2 as any).classCategories);

    const v2Rows = db.prepare('SELECT * FROM run_class_categories WHERE run_id = ?').all('run_v2');
    expect(v2Rows.length).toBe(0);

    // 2. 執行 v3 run 並走真實生產呼叫鏈 saveCalculationRun
    const resV3 = executeCalculationRun(db, 'imp_test', 'run_v3', {
      ruleSetVersion: 'erp-tag-v3' as any,
    });
    saveCalculationRun(db, resV3.run, resV3.results, (resV3 as any).classCategories);

    const v3Rows = db.prepare('SELECT * FROM run_class_categories WHERE run_id = ?').all('run_v3') as any[];
    expect(v3Rows.length).toBeGreaterThan(0);

    const hwRow = v3Rows.find((r) => r.base_name === '國小輔導-寫功課');
    expect(hwRow).toBeDefined();
    expect(hwRow.category).toBe('none');
    expect(hwRow.fixed_five_days).toBe(1); // 寫功課固定 5 天
    expect(hwRow.mapped).toBe(0); // 寫功課不在 seed 內，mapped 為 0
    expect(hwRow.source).toBe('auto');

    const seedRow = v3Rows.find((r) => r.base_name === '國小輔導-四年級');
    expect(seedRow).toBeDefined();
    expect(seedRow.category).toBe('care');
    expect(seedRow.mapped).toBe(1); // 國小輔導-四年級為 seed 班級，mapped 應為 1 (R2-2)
    expect(seedRow.source).toBe('auto');
  });

  it('v2 run 重存時 student_calculations 不被級聯刪除 (R2-1)', () => {
    const resV2 = executeCalculationRun(db, 'imp_test', 'run_v2_resave', {
      ruleSetVersion: 'erp-tag-v2',
    });
    saveCalculationRun(db, resV2.run, resV2.results);

    const beforeCount = (db.prepare('SELECT count(*) as c FROM student_calculations WHERE run_id = ?').get('run_v2_resave') as any).c;
    expect(beforeCount).toBeGreaterThan(0);

    // 嘗試重存空計算結果（若為 INSERT OR REPLACE 會觸發 CASCADE DELETE 刪除已存在的 calculations）
    try {
      saveCalculationRun(db, resV2.run, []);
    } catch {
      // INSERT INTO 應拋出 UNIQUE/PRIMARY KEY constraint 錯誤而非靜默替換
    }

    const afterCount = (db.prepare('SELECT count(*) as c FROM student_calculations WHERE run_id = ?').get('run_v2_resave') as any).c;
    expect(afterCount).toBe(beforeCount); // calculations 不得被刪除到 0
  });

  it('讀模型: 不列入但固定 5 天的班級，本班適用折扣顯示 100% (10000 bps) 而非 not_configured', () => {
    executeCalculationRun(db, 'imp_test', 'run_v3_rate', {
      ruleSetVersion: 'erp-tag-v3' as any,
    });

    const rate = (applicableRateForClass as any)('國小輔導-寫功課', {
      grade: 4,
      applicableAnqinBps: 10000,
      applicableTutoringBps: 10000,
      applicableMathBps: 10000,
      applicableEnglishBps: 10000,
    }, { db, runId: 'run_v3_rate' });

    expect(rate.status).toBe('configured');
    expect(rate.bps).toBe(10000);
  });
});
