import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { getCalculationRun, saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import { executeCalculationRun } from '@/application/calculate-run';

describe('PR-3 additive immutable run class semantics snapshot', () => {
  let db: Database.Database | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('writes a new v4 snapshot with explicit seed semantics and blocks later mutation', () => {
    db = new Database(':memory:');
    runMigrations(db);
    const now = '2026-10-23T00:00:00.000Z';
    saveImportBatch(db, {
      id: 'imp_semantics', fileName: 'synthetic.xlsx', fileHash: 'synthetic-hash',
      contentHash: 'synthetic-content', sheetName: 'Sheet1', headerMap: {},
      parserVersion: '1.0.0', scopeNote: '', rowCount: 1, status: 'ready', createdAt: now,
    }, [{
      personCode: 'SYNTH-001', name: '合成學生', grade: 4, gradeRaw: '4', gradeStatus: 'valid',
      branch: null, contact: null, schoolInfo: null, tagsRaw: '', tags: [], notesRaw: '', sourceRow: 1,
      enrollments: [{ rawToken: '國小數學-一A', yearPrefix: null, baseName: '國小數學-一A', groupFlag: null,
        modifiers: [], withdrawalDate: null, erpBillingTierRaw: null, erpBillingTier: null,
        tierParseStatus: 'not_applicable', parseStatus: 'ok' }],
    }]);

    const calculated = executeCalculationRun(db, 'imp_semantics', 'run_semantics', {
      scheduleVersionId: 'seed-v250922', ruleSetVersion: 'erp-tag-v4', asOfDate: '2026-10-23',
    });
    const classSemantics = calculated.classSemantics?.map((item) => ({
      ...item,
      summaryDayRolesJson: JSON.stringify(['mathDays', 'saturdayTutoringDays']),
      summaryDayRoleConditionsJson: JSON.stringify([
        { role: 'saturdayTutoringDays', condition: 'raw_token_contains_six' },
      ]),
    }));
    saveCalculationRun(db, calculated.run, calculated.results, calculated.classCategories, classSemantics);

    const loaded = getCalculationRun(db, 'run_semantics');
    const math = loaded?.classSemantics?.find((item) => item.baseName === '國小數學-一A');
    expect(math).toMatchObject({
      classTypeId: 'non_care',
      subject: '國小數學',
      subjectSource: 'seed',
      category: 'math',
      categorySource: 'seed',
      summaryDayRoles: ['mathDays', 'saturdayTutoringDays'],
      summaryDayRolesStatus: 'configured',
      summaryDayRolesSource: 'seed',
      erpTierApplicability: 'not_applicable',
    });
    expect(math?.summaryDayRoleConditions).toEqual([
      { role: 'saturdayTutoringDays', condition: 'raw_token_contains_six' },
    ]);
    expect(math?.classTypeDefinitionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => db!.prepare(
      'UPDATE run_class_semantics SET subject = ? WHERE run_id = ? AND base_name = ?'
    ).run('改寫', 'run_semantics', '國小數學-一A')).toThrow(/immutable/);
    expect(getCalculationRun(db, 'run_semantics')?.classSemantics?.find((item) => item.baseName === '國小數學-一A')?.subject)
      .toBe('國小數學');

    const missingSnapshotRunId = 'run_missing_semantics';
    expect(() => saveCalculationRun(
      db!, { ...calculated.run, id: missingSnapshotRunId }, calculated.results, calculated.classCategories
    )).toThrow(/明確提供 classSemantics/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM calculation_runs WHERE id = ?').get(missingSnapshotRunId)).toEqual({ n: 0 });

    saveCalculationRun(db, { ...calculated.run, id: 'run_empty_semantics', totalStudents: 0 }, [], [], []);
    expect(getCalculationRun(db, 'run_empty_semantics')?.classSemantics).toEqual([]);
    expect(() => db!.prepare(
      'UPDATE run_semantics_snapshots SET snapshot_schema_version = 3 WHERE run_id = ?'
    ).run('run_empty_semantics')).toThrow(/immutable/);

    db.exec('DROP TRIGGER run_class_semantics_immutable_update');
    const originalDefinition = db.prepare(
      'SELECT class_type_definition_hash FROM run_class_semantics WHERE run_id = ? AND base_name = ?'
    ).get('run_semantics', '國小數學-一A') as { class_type_definition_hash: string };
    db.prepare('UPDATE run_class_semantics SET class_type_definition_hash = ? WHERE run_id = ? AND base_name = ?')
      .run('0'.repeat(64), 'run_semantics', '國小數學-一A');
    expect(() => getCalculationRun(db!, 'run_semantics')).toThrow(/definition hash mismatch/);
    db.prepare('UPDATE run_class_semantics SET class_type_definition_hash = ?, class_type_id = ? WHERE run_id = ? AND base_name = ?')
      .run(originalDefinition.class_type_definition_hash, 'care', 'run_semantics', '國小數學-一A');
    expect(() => getCalculationRun(db!, 'run_semantics')).toThrow(/class type id does not match/);
    db.prepare('UPDATE run_class_semantics SET class_type_id = ?, summary_day_roles_json = ? WHERE run_id = ? AND base_name = ?')
      .run('non_care', '{}', 'run_semantics', '國小數學-一A');
    expect(() => getCalculationRun(db!, 'run_semantics')).toThrow(/roles are invalid/);

    // A definition cannot be retained after its identifying classTypeId is removed.
    db.prepare('UPDATE run_class_semantics SET summary_day_roles_json = ?, class_type_id = NULL WHERE run_id = ? AND base_name = ?')
      .run('["mathDays"]', 'run_semantics', '國小數學-一A');
    expect(() => getCalculationRun(db!, 'run_semantics')).toThrow(/class type id does not match/);

    // A markerless v4 run with rows is corrupt, not a historical run without a snapshot.
    db.prepare('DELETE FROM run_semantics_snapshots WHERE run_id = ?').run('run_semantics');
    expect(() => getCalculationRun(db!, 'run_semantics')).toThrow(/without a snapshot header/);

    // Failure after the run, result, category and header writes must roll all of them back.
    const rollbackRunId = 'run_semantic_insert_failure';
    const rollbackRun = { ...calculated.run, id: rollbackRunId };
    const rollbackResults = calculated.results.map((item) => ({
      ...item,
      id: `rollback-${item.id}`,
      runId: rollbackRunId,
    }));
    expect(rollbackResults.length).toBeGreaterThan(0);
    expect(calculated.classCategories?.length ?? 0).toBeGreaterThan(0);
    db.exec(`CREATE TRIGGER fail_run_class_semantics_insert
      BEFORE INSERT ON run_class_semantics
      BEGIN SELECT RAISE(ABORT, 'injected semantic row failure'); END`);
    expect(() => saveCalculationRun(
      db!, rollbackRun, rollbackResults, calculated.classCategories, calculated.classSemantics
    )).toThrow(/injected semantic row failure/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM calculation_runs WHERE id = ?').get(rollbackRunId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM student_calculations WHERE run_id = ?').get(rollbackRunId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_class_categories WHERE run_id = ?').get(rollbackRunId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_semantics_snapshots WHERE run_id = ?').get(rollbackRunId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_class_semantics WHERE run_id = ?').get(rollbackRunId)).toEqual({ n: 0 });
  });

  it('adds the semantic table without rewriting historical class-category rows', () => {
    db = new Database(':memory:');
    const sourceDir = path.resolve(process.cwd(), 'src/adapters/sqlite/migrations');
    const migrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd3-migrations-'));
    try {
      for (const file of fs.readdirSync(sourceDir).filter((name) => /^\d+_.+\.sql$/.test(name) && Number(name.slice(0, 4)) < 9)) {
        fs.copyFileSync(path.join(sourceDir, file), path.join(migrationDir, file));
      }
      runMigrations(db, migrationDir);
      db.exec(`INSERT INTO import_batches (
        id, file_name, file_hash, content_hash, sheet_name, header_map, parser_version, scope_note,
        row_count, status, created_at
      ) VALUES ('old-import', 'synthetic.xlsx', 'h', 'c', 'Sheet1', '{}', '1', '', 0, 'ready', '2026-01-01')`);
      db.exec(`INSERT INTO calculation_runs (
        id, import_id, schedule_version_id, rule_set_version, numeric_policy, as_of_date, status,
        issue_counts, total_students, created_at
      ) VALUES ('old-run', 'old-import', 'old-settings', 'erp-tag-v4', 'p', '2026-01-01', 'completed', '{}', 0, '2026-01-01')`);
      db.exec(`INSERT INTO run_class_categories (run_id, base_name, category, fixed_five_days, mapped, source)
        VALUES ('old-run', 'synthetic-class', 'math', 0, 1, 'seed')`);
      const before = db.prepare('SELECT * FROM run_class_categories WHERE run_id = ?').all('old-run');

      runMigrations(db, sourceDir);
      expect(db.prepare('SELECT * FROM run_class_categories WHERE run_id = ?').all('old-run')).toEqual(before);
      expect(db.prepare('SELECT COUNT(*) AS n FROM run_class_semantics').get()).toEqual({ n: 0 });
      expect(getCalculationRun(db, 'old-run')?.classSemantics).toBeUndefined();
      expect(db.prepare('SELECT version FROM schema_migrations WHERE version = 9').get()).toBeDefined();
    } finally {
      fs.rmSync(migrationDir, { recursive: true, force: true });
    }
  });
});
