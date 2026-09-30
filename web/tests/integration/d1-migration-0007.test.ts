import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations, getAppliedMigrations } from '@/adapters/sqlite/migrator';

/**
 * D1（specs/11 §3 D1、04 §8 UX42；S manifest §1.3、§2.3、§11.1、§A F-15）：migration 0007，只加欄位或加表。
 *  - `settings_previews.target_rule_set_version`（TEXT，nullable）：preview 記錄的目標規則版本；
 *  - `run_class_categories`：D2 寫入「run 實際採用的類別」的表；D1 期間保持空表、不寫入。
 * 不變式：不重寫任何既有列；`getDatabase()` 首次讀取就會執行 migration（F-15），所以升級與 fresh 兩條路徑都要驗；
 * 故障整段 rollback、可重跑。仿照 migration-0006-nullable.test.ts。
 */

const REAL_DIR = path.resolve(__dirname, '../../src/adapters/sqlite/migrations');

interface ColInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

describe('UX42：migration 0007——settings_previews.target_rule_set_version、run_class_categories', () => {
  let tempDir: string;
  let db: Database.Database;

  function migrationsDir(maxVersion: number, tamper?: (sql: string) => string): string {
    const dir = fs.mkdtempSync(path.join(tempDir, 'mig-'));
    for (const f of fs.readdirSync(REAL_DIR).filter((n) => /^\d+_.+\.sql$/.test(n))) {
      const v = parseInt(f.split('_')[0], 10);
      if (v > maxVersion) continue;
      let sql = fs.readFileSync(path.join(REAL_DIR, f), 'utf-8');
      if (v === 7 && tamper) sql = tamper(sql);
      fs.writeFileSync(path.join(dir, f), sql);
    }
    return dir;
  }

  const cols = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as ColInfo[];
  const col = (table: string, name: string) => cols(table).find((c) => c.name === name);
  const tableNames = () =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);

  /** 在 v6 舊 schema 寫入代表性舊資料：active_state、import、run、preview（含 expires_at 與 null）、idempotency、settings_versions。 */
  function seedLegacyRows() {
    db.prepare("UPDATE active_state SET active_import_id = 'imp_1', active_run_id = 'run_1', revision = 3 WHERE id = 1").run();
    db.prepare(
      `INSERT INTO import_batches (id, file_name, file_hash, content_hash, sheet_name, header_map, parser_version, scope_note, row_count, status, created_at)
       VALUES ('imp_1', 'a.xlsx', 'fh', 'ch', 'S', '{}', '1', '', 0, 'ready', '2026-09-01T00:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO calculation_runs (id, import_id, schedule_version_id, rule_set_version, numeric_policy, as_of_date, status, issue_counts, total_students, created_at)
       VALUES ('run_1', 'imp_1', 'seed-v250922', 'erp-tag-v2', 'p', '2026-09-01', 'completed', '{}', 0, '2026-09-01T00:00:00.000Z')`
    ).run();
    const ins = db.prepare(
      `INSERT INTO settings_previews (preview_id, input_hash, draft_json, expected_revision, settings_version_id, import_id, result_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    ins.run('setprev_a', 'h'.repeat(64), '{"classes":[{"baseName":"國小數學-一A"}]}', 1, 'seed-v250922', 'imp_1', '{"affectedStudents":13}', '2026-09-01T00:00:00.000Z', '2026-09-01T00:15:00.000Z');
    ins.run('setprev_b', 'i'.repeat(64), '{"classes":[]}', 2, 'setv_x', null, '{"mode":"settings_only"}', '2026-09-02T00:00:00.000Z', null);
    db.prepare(
      `INSERT INTO settings_versions (id, content_hash, content_json, effective_from, effective_to, created_at, created_from_preview_id, revision)
       VALUES ('setv_x', 'x', '{"classes":[]}', NULL, NULL, '2026-09-02T00:00:00.000Z', 'setprev_b', 1)`
    ).run();
    db.prepare(
      `INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at)
       VALUES ('k1', 'apply:setprev_a:1', 'run_1', '{"runId":"run_1"}', '2026-09-01T00:01:00.000Z')`
    ).run();
  }

  const dump = () => ({
    active: db.prepare('SELECT * FROM active_state').all(),
    batches: db.prepare('SELECT * FROM import_batches').all(),
    runs: db.prepare('SELECT * FROM calculation_runs').all(),
    versions: db.prepare('SELECT * FROM settings_versions').all(),
    idempotency: db.prepare('SELECT * FROM idempotency_records ORDER BY idempotency_key').all(),
    previews: db.prepare('SELECT preview_id, input_hash, draft_json, expected_revision, settings_version_id, import_id, result_json, created_at, expires_at FROM settings_previews ORDER BY preview_id').all(),
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mig7-test-'));
  });

  afterEach(() => {
    if (db) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('fresh DB：跑完全部 migration 後，兩個物件都存在且 schema 符合契約（版本 1–7 依序套用）', () => {
    db = createDatabase(path.join(tempDir, 'fresh.sqlite'));
    runMigrations(db, REAL_DIR);
    expect(getAppliedMigrations(db).map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const target = col('settings_previews', 'target_rule_set_version');
    expect(target, 'settings_previews.target_rule_set_version').toBeDefined();
    expect(target).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 });

    expect(tableNames()).toContain('run_class_categories');
    const c = Object.fromEntries(cols('run_class_categories').map((x) => [x.name, x]));
    expect(Object.keys(c).sort()).toEqual(['base_name', 'category', 'fixed_five_days', 'mapped', 'run_id', 'source']);
    for (const name of ['run_id', 'base_name', 'category', 'source']) expect(c[name]).toMatchObject({ type: 'TEXT', notnull: 1 });
    for (const name of ['fixed_five_days', 'mapped']) expect(c[name]).toMatchObject({ type: 'INTEGER', notnull: 1 });
    // 複合主鍵 (run_id, base_name)
    expect(c.run_id.pk).toBe(1);
    expect(c.base_name.pk).toBe(2);
    // 外鍵：run 刪除時連帶刪除
    const fks = db.prepare('PRAGMA foreign_key_list(run_class_categories)').all() as Array<{ table: string; from: string; to: string; on_delete: string }>;
    expect(fks).toEqual([expect.objectContaining({ table: 'calculation_runs', from: 'run_id', to: 'id', on_delete: 'CASCADE' })]);
    // D1 期間空表
    expect((db.prepare('SELECT COUNT(*) AS n FROM run_class_categories').get() as { n: number }).n).toBe(0);
  });

  it('升級 DB（v6 有舊資料）：套用 0007 後所有舊列逐欄不變；新欄位對舊 preview 為 NULL；新表為空', () => {
    db = createDatabase(path.join(tempDir, 'legacy.sqlite'));
    runMigrations(db, migrationsDir(6));
    seedLegacyRows();
    expect(col('settings_previews', 'target_rule_set_version')).toBeUndefined();
    const before = dump();

    const result = runMigrations(db, REAL_DIR);
    expect(result.applied).toEqual([expect.stringMatching(/^0007_/)]);
    expect(dump()).toEqual(before);
    expect(db.prepare('SELECT preview_id, target_rule_set_version AS t FROM settings_previews ORDER BY preview_id').all()).toEqual([
      { preview_id: 'setprev_a', t: null },
      { preview_id: 'setprev_b', t: null },
    ]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM run_class_categories').get() as { n: number }).n).toBe(0);
  });

  it('可重跑：第二次 runMigrations 不再套用（idempotent），資料不變', () => {
    db = createDatabase(path.join(tempDir, 'rerun.sqlite'));
    runMigrations(db, REAL_DIR);
    const again = runMigrations(db, REAL_DIR);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied.some((f) => f.startsWith('0007_'))).toBe(true);
  });

  it('故障整段 rollback：0007 中途失敗 → 仍停在 v6、舊資料完整、沒有殘留的新欄位或新表', () => {
    db = createDatabase(path.join(tempDir, 'rollback.sqlite'));
    runMigrations(db, migrationsDir(6));
    seedLegacyRows();
    const before = dump();

    const broken = migrationsDir(7, (sql) => sql + '\nINSERT INTO no_such_table_for_rollback VALUES (1);\n');
    expect(() => runMigrations(db, broken)).toThrowError(/0007.*failed and rolled back/);

    expect(getAppliedMigrations(db).map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(col('settings_previews', 'target_rule_set_version')).toBeUndefined();
    expect(tableNames()).not.toContain('run_class_categories');
    expect(dump()).toEqual(before);
  });

  it('run_class_categories 的外鍵行為：未知 run 不可寫入；run 刪除時連帶刪除；同 run 同班名不可重複', () => {
    db = createDatabase(path.join(tempDir, 'fk.sqlite'));
    runMigrations(db, REAL_DIR);
    expect(tableNames(), 'migration 0007 需建立 run_class_categories').toContain('run_class_categories');
    const insert = db.prepare(
      'INSERT INTO run_class_categories (run_id, base_name, category, fixed_five_days, mapped, source) VALUES (?, ?, ?, ?, ?, ?)'
    );
    expect(() => insert.run('run_unknown', '國小數學-X', 'math', 0, 1, 'auto')).toThrow(/FOREIGN KEY/);

    seedLegacyRowsForFk();
    insert.run('run_fk', '國小數學-X', 'math', 0, 1, 'auto');
    expect(() => insert.run('run_fk', '國小數學-X', 'none', 0, 1, 'manual')).toThrow(/UNIQUE|PRIMARY KEY/);
    db.prepare('DELETE FROM calculation_runs WHERE id = ?').run('run_fk');
    expect((db.prepare('SELECT COUNT(*) AS n FROM run_class_categories').get() as { n: number }).n).toBe(0);

    function seedLegacyRowsForFk() {
      db.prepare(
        `INSERT INTO import_batches (id, file_name, file_hash, content_hash, sheet_name, header_map, parser_version, scope_note, row_count, status, created_at)
         VALUES ('imp_fk', 'a.xlsx', 'fh', 'ch', 'S', '{}', '1', '', 0, 'ready', '2026-09-01T00:00:00.000Z')`
      ).run();
      db.prepare(
        `INSERT INTO calculation_runs (id, import_id, schedule_version_id, rule_set_version, numeric_policy, as_of_date, status, issue_counts, total_students, created_at)
         VALUES ('run_fk', 'imp_fk', 'seed-v250922', 'erp-tag-v2', 'p', '2026-09-01', 'completed', '{}', 0, '2026-09-01T00:00:00.000Z')`
      ).run();
    }
  });
});
