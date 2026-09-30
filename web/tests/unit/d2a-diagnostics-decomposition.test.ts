import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { executeCalculationRun } from '@/application/calculate-run';

describe('D2a: 診斷標籤分解 (Diagnostics Decomposition, Q12)', () => {
  it('手算案例 D-01: v3 因選班政策產生天數差，出 RULESET_POLICY_DIFFERENCE 而非單一 NUMERIC_POLICY_DIFFERENCE', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const now = new Date().toISOString();
    saveImportBatch(
      db,
      {
        id: 'imp_diag',
        fileName: 'diag.xlsx',
        fileHash: 'hash_diag',
        contentHash: 'hash_diag',
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
          name: '診斷測試生',
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
              rawToken: '兒童美語-甲',
              yearPrefix: null,
              baseName: '兒童美語-甲',
              groupFlag: null,
              modifiers: [],
              withdrawalDate: null,
              erpBillingTierRaw: null,
              erpBillingTier: null,
              tierParseStatus: 'not_applicable',
              parseStatus: 'ok',
            },
            {
              rawToken: '兒童美語-乙',
              yearPrefix: null,
              baseName: '兒童美語-乙',
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

    const scheduleOverride = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
      ['兒童美語-甲', [{ start: 990, end: 1080, weekday: '一' }]],
      ['兒童美語-乙', [{ start: 990, end: 1140, weekday: '二' }]],
    ]);

    // 執行 v3 run
    const resultV3 = executeCalculationRun(db, 'imp_diag', 'run_v3_diag', {
      ruleSetVersion: 'erp-tag-v3' as any,
      scheduleOverride,
    });

    const issuesRaw = resultV3.results[0].issues;
    const issuesV3 = (Array.isArray(issuesRaw) ? issuesRaw : JSON.parse(issuesRaw as any)) as Array<{ code: string }>;
    expect(issuesV3.some((i) => i.code === 'RULESET_POLICY_DIFFERENCE')).toBe(true);
    expect(issuesV3.some((i) => i.code === 'NUMERIC_POLICY_DIFFERENCE')).toBe(false);

    db.close();
  });
});
