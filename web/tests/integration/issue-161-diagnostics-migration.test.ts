import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '@/adapters/sqlite/db';
import { getAppliedMigrations, runMigrations } from '@/adapters/sqlite/migrator';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/adapters/sqlite/migrations');

describe('Issue #161 migration 0008: historical rows stay unavailable', () => {
  let tempDir: string;
  let db: Database.Database;

  const migrationsDir = (maxVersion: number, breakV8 = false) => {
    const dir = fs.mkdtempSync(path.join(tempDir, 'migrations-'));
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => /^\d+_.+\.sql$/.test(name))) {
      const version = Number(file.split('_')[0]);
      if (version > maxVersion) continue;
      let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      if (version === 8 && breakV8) sql += '\nINSERT INTO missing_table_for_rollback VALUES (1);\n';
      fs.writeFileSync(path.join(dir, file), sql);
    }
    return dir;
  };

  const seedOldRun = () => {
    db.prepare(`INSERT INTO import_batches
      (id, file_name, file_hash, content_hash, sheet_name, header_map, parser_version, scope_note, row_count, status, created_at)
      VALUES ('imp_old', 'synthetic.xlsx', 'fh', 'ch', 'S', '{}', '1', '', 1, 'ready', '2026-10-20T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO calculation_runs
      (id, import_id, schedule_version_id, rule_set_version, numeric_policy, as_of_date, status, issue_counts, total_students, created_at)
      VALUES ('run_old', 'imp_old', 'seed-v250922', 'erp-tag-v4', 'integer-minute-rational-v1', '2026-10-20', 'completed', '{}', 1, '2026-10-20T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO student_calculations
      (id, run_id, person_code, name, tier_comparisons, issues, trace, created_at)
      VALUES ('calc_old', 'run_old', 'SYNTH_OLD', '合成學生', '[]', '[]', '{"sourceRow":1}', '2026-10-20T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO run_class_categories (run_id, base_name, category, fixed_five_days, mapped, source)
      VALUES ('run_old', '合成班級', 'unset', 0, 0, 'unset')`).run();
    db.prepare('UPDATE active_state SET active_import_id = ?, active_run_id = ?, revision = ? WHERE id = 1')
      .run('imp_old', 'run_old', 9);
    db.prepare(`INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at)
      VALUES ('key_old', 'hash_old', 'run_old', '{"runId":"run_old"}', '2026-10-20T00:00:00.000Z')`).run();
  };

  const dump = () => ({
    active: db.prepare('SELECT * FROM active_state').all(),
    imports: db.prepare('SELECT * FROM import_batches').all(),
    runs: db.prepare('SELECT * FROM calculation_runs').all(),
    calculations: db.prepare('SELECT * FROM student_calculations').all(),
    categories: db.prepare('SELECT * FROM run_class_categories').all(),
    idempotency: db.prepare('SELECT * FROM idempotency_records').all(),
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-issue161-migration-'));
  });

  afterEach(() => {
    db?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('fresh schema adds nullable run version and one-to-one FK diagnostics table', () => {
    db = createDatabase(path.join(tempDir, 'fresh.sqlite'));
    runMigrations(db, MIGRATIONS_DIR);
    expect(getAppliedMigrations(db).map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const runVersion = (db.prepare('PRAGMA table_info(calculation_runs)').all() as any[]).find((column) => column.name === 'diagnostic_algorithm_version');
    expect(runVersion).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    const table = (db.prepare('PRAGMA table_info(run_diagnostics)').all() as any[]);
    expect(table.map((column) => column.name)).toEqual([
      'run_id', 'algorithm_version', 'payload_schema_version', 'payload_json', 'effective_inputs_json',
      'payload_hash', 'effective_inputs_hash', 'formal_result_hash', 'created_at',
    ]);
    expect(table[0].pk).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_list(run_diagnostics)').all()).toEqual([
      expect.objectContaining({ table: 'calculation_runs', from: 'run_id', to: 'id', on_delete: 'CASCADE' }),
    ]);
  });

  it('upgrade from v7 leaves every historical row unchanged and version NULL; rerun is a no-op', () => {
    db = createDatabase(path.join(tempDir, 'upgrade.sqlite'));
    runMigrations(db, migrationsDir(7));
    seedOldRun();
    const before = dump();

    expect(runMigrations(db, MIGRATIONS_DIR).applied).toEqual(['0008_run_diagnostics.sql']);
    expect(dump()).toEqual({
      ...before,
      runs: (before.runs as any[]).map((run) => ({ ...run, diagnostic_algorithm_version: null })),
    });
    expect(db.prepare('SELECT count(*) as n FROM run_diagnostics').get()).toMatchObject({ n: 0 });
    expect(runMigrations(db, MIGRATIONS_DIR).applied).toEqual([]);
  });

  it('migration failure rolls back the added column, table, trigger, migration record, and all old rows', () => {
    db = createDatabase(path.join(tempDir, 'rollback.sqlite'));
    runMigrations(db, migrationsDir(7));
    seedOldRun();
    const before = dump();
    expect(() => runMigrations(db, migrationsDir(8, true))).toThrow(/0008.*failed and rolled back/);
    expect(getAppliedMigrations(db).map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect((db.prepare('PRAGMA table_info(calculation_runs)').all() as any[]).some((column) => column.name === 'diagnostic_algorithm_version')).toBe(false);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_diagnostics'").get()).toBeUndefined();
    expect(dump()).toEqual(before);
  });

  it('diagnostics are insert-only while run deletion cascades to the snapshot', () => {
    db = createDatabase(path.join(tempDir, 'fk.sqlite'));
    runMigrations(db, MIGRATIONS_DIR);
    seedOldRun();
    const insert = `INSERT INTO run_diagnostics
      (run_id, algorithm_version, payload_schema_version, payload_json, effective_inputs_json, payload_hash, effective_inputs_hash, formal_result_hash, created_at)
      VALUES ('run_old', 'comparison-snapshot-v1', 1, '{}', '{}', 'p', 'e', 'f', '2026-10-20T00:00:00.000Z')`;
    db.prepare(insert).run();
    expect(() => db.prepare("UPDATE run_diagnostics SET payload_json = '{}' WHERE run_id = 'run_old'").run()).toThrow(/immutable/);
    expect(() => db.prepare(insert).run()).toThrow(/UNIQUE|PRIMARY KEY/);
    db.prepare("DELETE FROM calculation_runs WHERE id = 'run_old'").run();
    expect(db.prepare('SELECT count(*) as n FROM run_diagnostics').get()).toMatchObject({ n: 0 });
  });
});
