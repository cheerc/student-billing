import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { executeCalculationRun } from '@/application/calculate-run';

describe('Issue #159 PR-2: new v4 runs omit retired diagnostic warnings', () => {
  it('a synthetic v4 student keeps formal business issues without diagnostic-only codes', () => {
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

    // 新 run 一律使用 v4。未映射合成課程仍保留 CLASS_NOT_MAPPED 業務警告。
    const resultV4 = executeCalculationRun(db, 'imp_diag', 'run_v4_diag', {
      ruleSetVersion: 'erp-tag-v4',
      scheduleOverride,
    });

    const issuesRaw = resultV4.results[0].issues;
    const issuesV4 = (Array.isArray(issuesRaw) ? issuesRaw : JSON.parse(issuesRaw as any)) as Array<{ code: string }>;
    expect(issuesV4.map((i) => i.code)).toContain('CLASS_NOT_MAPPED');
    expect(issuesV4.map((i) => i.code)).not.toContain('RULESET_POLICY_DIFFERENCE');
    expect(issuesV4.map((i) => i.code)).not.toContain('NUMERIC_POLICY_DIFFERENCE');
    expect(Object.keys(resultV4.run.issueCounts)).not.toContain('RULESET_POLICY_DIFFERENCE');
    expect(Object.keys(resultV4.run.issueCounts)).not.toContain('NUMERIC_POLICY_DIFFERENCE');
    expect(resultV4.run.diagnosticAlgorithmVersion).toBeUndefined();
    expect(resultV4.run.diagnostics).toBeUndefined();

    db.close();
  });
});
