import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { executeCalculationRun } from '@/application/calculate-run';
import { applicableRateForClass, loadRunClassCategories } from '@/application/applicable-rate';
import { saveCalculationRun, type CalculationRunRecord } from '@/adapters/sqlite/runs-repository';
import { buildSeedDraft, saveSettingsVersion } from '@/adapters/sqlite/settings-repository';

/**
 * D2a N-6 historical projection contract and current v4 snapshot persistence.
 * Historical v2/v3 fixtures are stored synthetic rows. New-run and alias behavior use v4.
 */
describe('D2b N-6: run_class_categories 快照持久化與讀模型（完整生產呼叫鏈）', () => {
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

  /** 以**名冊班名**查該 run 的類別快照（與 UI 的查詢 key 同源；secondary N-8 對齊）。 */
  function snapshotLookup(d: Database.Database, runId: string) {
    const rows = loadRunClassCategories(d, runId);
    return (name: string) => rows.find((r) => r.base_name === name);
  }

  function saveHistoricalRun(runId: string, version: 'erp-tag-v2' | 'erp-tag-v3', categories?: Array<{
    baseName: string; category: string; fixedFiveDays: number; mapped: number; source: string;
  }>) {
    const run: CalculationRunRecord = {
      id: runId, importId: 'imp_test', scheduleVersionId: 'seed-v250922', ruleSetVersion: version,
      numericPolicy: 'integer-minute-rational-v1', asOfDate: '2026-09-30', status: 'completed',
      issueCounts: {}, totalStudents: 1, createdAt: '2026-09-30T00:00:00.000Z',
    };
    saveCalculationRun(db, run, [], categories);
  }

  it('persisted v3 run 保留類別快照、v2 run 沒有快照列 (R2-1)', () => {
    saveHistoricalRun('run_v2', 'erp-tag-v2');

    const v2Rows = db.prepare('SELECT * FROM run_class_categories WHERE run_id = ?').all('run_v2');
    expect(v2Rows.length).toBe(0);

    saveHistoricalRun('run_v3', 'erp-tag-v3', [
      { baseName: '國小輔導-寫功課', category: 'unset', fixedFiveDays: 0, mapped: 0, source: 'unset' },
      { baseName: '國小輔導-四年級', category: 'care', fixedFiveDays: 0, mapped: 1, source: 'seed' },
    ]);

    const v3Rows = db.prepare('SELECT * FROM run_class_categories WHERE run_id = ?').all('run_v3') as any[];
    expect(v3Rows.length).toBeGreaterThan(0);

    // #157 Ruling 1／3：班名不參與類別判定。名冊中的「國小輔導-寫功課」不在課表設定內
    // → 未對應 → category=unset、mapped=0、source=unset。
    const hwRow = v3Rows.find((r) => r.base_name === '國小輔導-寫功課');
    expect(hwRow).toBeDefined();
    expect(hwRow.category).toBe('unset');
    expect(hwRow.fixed_five_days).toBe(0);
    expect(hwRow.mapped).toBe(0);
    expect(hwRow.source).toBe('unset');

    // 「國小輔導-四年級」是 seed 的班 → 已對應，且套用 **seed 基準**（機構既有的班級設定）。
    // #157：seed 基準**不是**使用者的決定，故 source=seed 而非 manual。
    const seedRow = v3Rows.find((r) => r.base_name === '國小輔導-四年級');
    expect(seedRow).toBeDefined();
    expect(seedRow.category).toBe('care');
    expect(seedRow.mapped).toBe(1);
    expect(seedRow.source).toBe('seed');
  });

  it('v4 run 重存時 student_calculations 不被級聯刪除 (R2-1)', () => {
    const resV4 = executeCalculationRun(db, 'imp_test', 'run_v4_resave', { ruleSetVersion: 'erp-tag-v4' });
    saveCalculationRun(db, resV4.run, resV4.results, resV4.classCategories, resV4.classSemantics);

    const beforeCount = (db.prepare('SELECT count(*) as c FROM student_calculations WHERE run_id = ?').get('run_v4_resave') as any).c;
    expect(beforeCount).toBeGreaterThan(0);

    try {
      saveCalculationRun(db, resV4.run, [], [], resV4.classSemantics);
    } catch {
      // INSERT INTO 應拋出 UNIQUE/PRIMARY KEY constraint 錯誤而非靜默替換
    }

    const afterCount = (db.prepare('SELECT count(*) as c FROM student_calculations WHERE run_id = ?').get('run_v4_resave') as any).c;
    expect(afterCount).toBe(beforeCount);
  });

  it('historical v3 read model: non-included fixed-five-days class keeps its 10000 bps projection', () => {
    saveHistoricalRun('run_v3_rate', 'erp-tag-v3', [
      { baseName: '國小輔導-寫功課', category: 'none', fixedFiveDays: 1, mapped: 1, source: 'manual' },
      { baseName: '國小輔導-四年級', category: 'care', fixedFiveDays: 0, mapped: 1, source: 'manual' },
    ]);

    // 適用率刻意使用 8888（非 10000）：若讀到 v2 名稱映射或 math/english 欄位，結果會是 8888 而非 10000，
    // 因此這個斷言能區分「真的命中 fixed_five_days 分支」與「誤命中別的分支」。
    const hw = applicableRateForClass(
      '國小輔導-寫功課',
      {
        grade: 4,
        applicableAnqinBps: 8888,
        applicableTutoringBps: 8888,
        applicableMathBps: 8888,
        applicableEnglishBps: 8888,
      },
      { ruleSetVersion: 'erp-tag-v3', findSnapshot: snapshotLookup(db, 'run_v3_rate') }
    );
    expect(hw).toEqual({ status: 'configured', bps: 10000 });

    // 對照組：同樣的類別欄位（care），非固定 5 天 → 依年級取課輔側 8888，證明兩條分支確實不同
    const care = applicableRateForClass(
      '國小輔導-四年級',
      {
        grade: 4,
        applicableAnqinBps: 8888,
        applicableTutoringBps: 8888,
        applicableMathBps: 8888,
        applicableEnglishBps: 8888,
      },
      { ruleSetVersion: 'erp-tag-v3', findSnapshot: snapshotLookup(db, 'run_v3_rate') }
    );
    expect(care).toEqual({ status: 'configured', bps: 8888 });
  });

  it('讀模型 (N-6): v3 run 缺該班快照時回 not_configured，不以當前班名猜測', () => {
    saveHistoricalRun('run_v3_missing', 'erp-tag-v3', [
      { baseName: '國小輔導-四年級', category: 'care', fixedFiveDays: 0, mapped: 1, source: 'seed' },
    ]);

    const r = applicableRateForClass(
      '國小數學-四A',
      {
        grade: 4,
        applicableAnqinBps: 8888,
        applicableTutoringBps: 8888,
        applicableMathBps: 8888,
        applicableEnglishBps: 8888,
      },
      { ruleSetVersion: 'erp-tag-v3', findSnapshot: snapshotLookup(db, 'run_v3_missing') }
    );
    // 國小數學-四A 是 seed 班級但本名單沒人報名，快照無此列 → not_configured（不是 8888 的猜測）
    expect(r.status).toBe('not_configured');
  });
});

/**
 * D2a 移交項 N-7（PR #43 secondary review）：alias 解析與手動來源缺少回歸測試。
 */
describe('D2b N-7: alias 解析與 manual 來源的快照回歸', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedOneStudent(baseName: string) {
    const now = new Date().toISOString();
    saveImportBatch(
      db,
      {
        id: 'imp_n7',
        fileName: 'n7.xlsx',
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
          personCode: 'N001',
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
              rawToken: baseName,
              yearPrefix: null,
              baseName,
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
  }

  it('N-7(a): 米豆奶班名經 alias 解析到系統班後 mapped=1，且不出 CLASS_NOT_MAPPED', () => {
    seedOneStudent('美語新班-2026春');

    const res = executeCalculationRun(db, 'imp_n7', 'run_alias', {
      ruleSetVersion: 'erp-tag-v4',
      aliasMap: new Map([['美語新班-2026春', '兒童美語-Gino']]),
    });
    saveCalculationRun(db, res.run, res.results, res.classCategories, res.classSemantics);

    const issues = res.results[0].issues as Array<{ code: string }>;
    expect(issues.some((i) => i.code === 'CLASS_NOT_MAPPED')).toBe(false);

    // 快照的 key 是名冊班名（讀模型與 UI 皆用它），而 mapped / category 是解析後的系統班屬性
    const row = db
      .prepare('SELECT * FROM run_class_categories WHERE run_id = ? AND base_name = ?')
      .get('run_alias', '美語新班-2026春') as any;
    expect(row).toBeDefined();
    // #157：alias 解析到系統班「兒童美語-Gino」後，該班的類別由**使用者的設定**決定；
    // 未指定 → 套用 seed 基準 → english/seed（舊制依班名寫成 english，但 source 是 auto）。
    expect(row.mapped).toBe(1);
    expect(row.category).toBe('english');
    expect(row.source).toBe('seed');
  });

  it('N-7(b): 沒有 alias 且系統無此班時 mapped=0，並對自動偵測為數學的未對應班出 CLASS_NOT_MAPPED', () => {
    seedOneStudent('國小數學-未對應新班');

    const res = executeCalculationRun(db, 'imp_n7', 'run_noalias', {
      ruleSetVersion: 'erp-tag-v4',
    });
    saveCalculationRun(db, res.run, res.results, res.classCategories, res.classSemantics);

    const issues = res.results[0].issues as Array<{ code: string }>;
    expect(issues.some((i) => i.code === 'CLASS_NOT_MAPPED')).toBe(true);

    const row = db
      .prepare('SELECT * FROM run_class_categories WHERE run_id = ? AND base_name = ?')
      .get('run_noalias', '國小數學-未對應新班') as any;
    // #157 Ruling 3：未對應班的快照類別一律 unset（不再依班名寫成 math）
    expect(row.mapped).toBe(0);
    expect(row.category).toBe('unset');
  });

  it('N-7(c): 設定草稿以 categorySource=manual 指定類別時，快照 source 為 manual', () => {
    seedOneStudent('交通車-東區');

    // 系統設定把「交通車-東區」手動指定為美語班（manual）
    const draft = buildSeedDraft();
    draft.classes.push({
      baseName: '交通車-東區',
      subject: '交通車',
      teacher: null,
      active: true,
      sessions: [],
      classTypeId: 'non_care',
      classType: 'non_care',
      subjectSource: 'manual',
      summaryDayRoles: [],
      summaryDayRolesStatus: 'unset',
      summaryDayRolesSource: 'unset',
      erpTierApplicability: 'unset',
      erpTierApplicabilitySource: 'unset',
      category: 'english',
      categorySource: 'manual',
    } as any);

    const versionId = 'setv_manual_test';
    saveSettingsVersion(db, {
      id: versionId,
      contentHash: 'h',
      contentJson: JSON.stringify(draft),
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: new Date().toISOString(),
      createdFromPreviewId: null,
      revision: 1,
    });

    const res = executeCalculationRun(db, 'imp_n7', 'run_manual', {
      ruleSetVersion: 'erp-tag-v4',
      scheduleVersionId: versionId,
    });
    saveCalculationRun(db, res.run, res.results, res.classCategories, res.classSemantics);

    const row = db
      .prepare('SELECT * FROM run_class_categories WHERE run_id = ? AND base_name = ?')
      .get('run_manual', '交通車-東區') as any;
    expect(row).toBeDefined();
    expect(row.source).toBe('manual');
    expect(row.category).toBe('english');
    expect(row.mapped).toBe(1);
  });
});
