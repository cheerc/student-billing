import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { executeCalculationRun } from '@/application/calculate-run';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import { queryStudentOptions } from '@/application/query-student-options';
import { createStudentPredicateBuilder } from '@/application/student-query-predicates';
import { normalizeStudentQuery } from '@/contracts/student-query';
import { ALLOWED_RUN_QUERY_PARAMS } from '@/application/query-students';

function seedStudentWithHomework(db: Database.Database, importId: string) {
  saveImportBatch(
    db,
    {
      id: importId,
      fileName: 'homework-roster.xlsx',
      fileHash: 'h-hw',
      contentHash: 'c-hw',
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
        personCode: 'S_HW',
        name: '寫功課學生',
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
            rawToken: '國小輔導-寫功課[團]',
            yearPrefix: null,
            baseName: '國小輔導-寫功課',
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

function activate(db: Database.Database, importId: string, runId: string, version: string = 'erp-tag-v4') {
  const res = executeCalculationRun(db, importId, runId, { ruleSetVersion: version as any });
  saveCalculationRun(db, res.run, res.results, res.classCategories);
  db.prepare('UPDATE active_state SET active_run_id = ?, active_import_id = ?, revision = revision + 1 WHERE id = 1').run(runId, importId);
  return res;
}

describe('Ruling 3: queryStudentOptions 與表格欄位一致性（優先讀快照，v4 下 none 班為 not_configured）', () => {
  let db: Database.Database;
  const RUN_ID = 'run_v4_hw';

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedStudentWithHomework(db, 'imp_hw');
    activate(db, 'imp_hw', RUN_ID, 'erp-tag-v4');
  });

  afterEach(() => db.close());

  it('1. 在 v4 run 下，單選「國小輔導-寫功課」（快照中 category=none）時，applicableRateContext.status 為 not_configured', () => {
    const res = queryStudentOptions(db, RUN_ID, {
      enrollmentKey: ['國小輔導-寫功課'],
    });

    expect(res.applicableRateContext.status).toBe('not_configured');
    expect(res.options.applicableDiscountBps).toHaveLength(0);
  });

  it('2. 在 v4 run 下，student-query-predicates 對 category=none 的班級做 applicableDiscountBps 查詢產出無效條件（sql: 0）', () => {
    const builder = createStudentPredicateBuilder(db, RUN_ID, 'imp_hw');
    const query = normalizeStudentQuery(
      {
        enrollmentKey: ['國小輔導-寫功課'],
        applicableDiscountBps: ['9500'],
      },
      ALLOWED_RUN_QUERY_PARAMS
    );

    const { where } = builder(query);
    // 當選定 none 班做適用率查詢時，不應匹配到任何學生
    const matched = db.prepare(`SELECT person_code FROM student_calculations sc WHERE ${where.sql}`).all(...where.args);
    expect(matched).toHaveLength(0);
  });
});
