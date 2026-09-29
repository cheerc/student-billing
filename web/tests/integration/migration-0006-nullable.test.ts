import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations, getAppliedMigrations } from '@/adapters/sqlite/migrator';

/**
 * 09 §8.2.3／04 §8 UX17：向前 migration（table rebuild）。
 * `settings_previews.import_id`（0004）與 `idempotency_records.run_id`（0003）改為可 null，
 * 以支援無學生的 settings_only 儲存；SQLite 不能以 ALTER 移除 NOT NULL，故重建表。
 * 必要條件：舊資料逐列保留（含 0005 的 expires_at、response_payload）、故障整段 rollback、不清 DB、可重跑。
 */

const REAL_DIR = path.resolve(__dirname, '../../src/adapters/sqlite/migrations');

interface ColInfo {
  name: string;
  notnull: number;
  pk: number;
}

describe('UX17：migration 0006——settings_previews.import_id、idempotency_records.run_id 改可 null', () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database.Database;

  /** 建一個只含 ≤ maxVersion 的 migrations 目錄；tamper 可改寫 0006 內容以注入故障。 */
  function migrationsDir(maxVersion: number, tamper?: (sql: string) => string): string {
    const dir = fs.mkdtempSync(path.join(tempDir, 'mig-'));
    for (const f of fs.readdirSync(REAL_DIR).filter((n) => /^\d+_.+\.sql$/.test(n))) {
      const v = parseInt(f.split('_')[0], 10);
      if (v > maxVersion) continue;
      let sql = fs.readFileSync(path.join(REAL_DIR, f), 'utf-8');
      if (v === 6 && tamper) sql = tamper(sql);
      fs.writeFileSync(path.join(dir, f), sql);
    }
    return dir;
  }

  function cols(table: string): ColInfo[] {
    return db.prepare(`PRAGMA table_info(${table})`).all() as ColInfo[];
  }
  const col = (table: string, name: string) => cols(table).find((c) => c.name === name)!;

  function tableNames(): string[] {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(
      (r) => r.name
    );
  }

  function dumpLegacyRows() {
    return {
      previews: db.prepare('SELECT * FROM settings_previews ORDER BY preview_id').all(),
      idempotency: db.prepare('SELECT * FROM idempotency_records ORDER BY idempotency_key').all(),
    };
  }

  /** 於 v5 舊 schema 寫入具代表性的舊資料（含 expires_at、null expires_at、中文與 JSON payload）。 */
  function seedLegacyRows() {
    const insPreview = db.prepare(
      `INSERT INTO settings_previews
        (preview_id, input_hash, draft_json, expected_revision, settings_version_id, import_id, result_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insPreview.run('setprev_a', 'h'.repeat(64), '{"classes":[{"baseName":"國小數學-一A"}]}', 1, 'seed-v250922', 'imp_1', '{"affectedStudents":13}', '2026-09-01T00:00:00.000Z', '2026-09-01T00:15:00.000Z');
    insPreview.run('setprev_b', 'i'.repeat(64), '{"classes":[]}', 2, 'setv_x', 'imp_2', '{"affectedStudents":0}', '2026-09-02T00:00:00.000Z', null);
    insPreview.run('setprev_c', 'j'.repeat(64), '{}', 0, 'seed-v250922', 'imp_3', '{}', '2026-09-03T00:00:00.000Z', '2026-09-03T00:15:00.000Z');

    const insIdem = db.prepare(
      `INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    insIdem.run('key-1', 'apply:setprev_a:1', 'run_1', '{"runId":"run_1","revision":2,"note":"逐列保留"}', '2026-09-01T00:01:00.000Z');
    insIdem.run('key-2', 'activate:imp_2:2', 'run_2', '{"runId":"run_2"}', '2026-09-02T00:01:00.000Z');
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mig6-test-'));
    dbPath = path.join(tempDir, 'legacy.sqlite');
    db = createDatabase(dbPath);
    runMigrations(db, migrationsDir(5));
    seedLegacyRows();
  });

  afterEach(() => {
    if (db) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('前提：v5 舊 schema 這兩欄為 NOT NULL（migration 前）', () => {
    expect(col('settings_previews', 'import_id').notnull).toBe(1);
    expect(col('idempotency_records', 'run_id').notnull).toBe(1);
    expect(getAppliedMigrations(db).map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it('套用 0006：兩欄改可 null，其餘欄位（含 0005 expires_at）與其 NOT NULL／PK 不變', () => {
    runMigrations(db);
    expect(getAppliedMigrations(db).map((m) => m.version)).toContain(6);

    expect(col('settings_previews', 'import_id').notnull).toBe(0);
    expect(col('idempotency_records', 'run_id').notnull).toBe(0);

    const sp = Object.fromEntries(cols('settings_previews').map((c) => [c.name, c]));
    expect(Object.keys(sp).sort()).toEqual(
      ['created_at', 'draft_json', 'expected_revision', 'expires_at', 'import_id', 'input_hash', 'preview_id', 'result_json', 'settings_version_id'].sort()
    );
    expect(sp.preview_id.pk).toBe(1);
    for (const n of ['input_hash', 'draft_json', 'expected_revision', 'settings_version_id', 'result_json', 'created_at']) {
      expect(sp[n].notnull).toBe(1);
    }
    expect(sp.expires_at.notnull).toBe(0);

    const ir = Object.fromEntries(cols('idempotency_records').map((c) => [c.name, c]));
    expect(Object.keys(ir).sort()).toEqual(['created_at', 'idempotency_key', 'request_body_hash', 'response_payload', 'run_id'].sort());
    expect(ir.idempotency_key.pk).toBe(1);
    for (const n of ['request_body_hash', 'response_payload', 'created_at']) {
      expect(ir[n].notnull).toBe(1);
    }
  });

  it('舊資料逐列保留（含 expires_at 的值與 NULL、response_payload、中文），不清 DB', () => {
    const before = dumpLegacyRows();
    expect(before.previews).toHaveLength(3);
    expect(before.idempotency).toHaveLength(2);

    runMigrations(db);

    const after = dumpLegacyRows();
    expect(after.previews).toEqual(before.previews);
    expect(after.idempotency).toEqual(before.idempotency);
  });

  it('migration 後：無多餘／殘留資料表、PK 唯一性仍生效、完整性檢查通過', () => {
    const namesBefore = tableNames();
    runMigrations(db);
    expect(tableNames()).toEqual(namesBefore);

    expect(() =>
      db
        .prepare(
          `INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at)
           VALUES ('key-1', 'x', NULL, '{}', 'now')`
        )
        .run()
    ).toThrow(/UNIQUE|PRIMARY/i);

    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('migration 後可寫入 null import_id／null run_id（settings_only 所需），且既有列不受影響', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO settings_previews
        (preview_id, input_hash, draft_json, expected_revision, settings_version_id, import_id, result_json, created_at, expires_at)
       VALUES ('setprev_null', 'k', '{}', 0, 'seed-v250922', NULL, '{}', 'now', 'later')`
    ).run();
    db.prepare(
      `INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at)
       VALUES ('key-null', 'apply:setprev_null:0', NULL, '{"runId":null}', 'now')`
    ).run();
    const p = db.prepare("SELECT import_id FROM settings_previews WHERE preview_id = 'setprev_null'").get() as any;
    const i = db.prepare("SELECT run_id FROM idempotency_records WHERE idempotency_key = 'key-null'").get() as any;
    expect(p.import_id).toBeNull();
    expect(i.run_id).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM settings_previews').get()).toEqual({ n: 4 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM idempotency_records').get()).toEqual({ n: 3 });
  });

  it('重跑已套用的 migration 為 no-op（冪等），資料不變', () => {
    runMigrations(db);
    const once = dumpLegacyRows();
    const again = runMigrations(db);
    expect(again.applied).toEqual([]);
    expect(dumpLegacyRows()).toEqual(once);
  });

  it('故障（0006 後段失敗）：整段 rollback——兩表 schema 與資料原封不動、v6 未記錄、DB 仍可用；移除故障後可重試成功', () => {
    const before = dumpLegacyRows();
    const namesBefore = tableNames();

    const broken = migrationsDir(6, (sql) => `${sql}\n;SELECT * FROM __no_such_table_to_force_failure__;`);
    expect(() => runMigrations(db, broken)).toThrow(/Migration 0006.*failed and rolled back/);

    // 兩張表都沒被改到（不是只回復其中一張）
    expect(col('settings_previews', 'import_id').notnull).toBe(1);
    expect(col('idempotency_records', 'run_id').notnull).toBe(1);
    expect(dumpLegacyRows()).toEqual(before);
    expect(tableNames()).toEqual(namesBefore);
    expect(getAppliedMigrations(db).map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);

    // 復原：以正式的 0006 重試即成功，資料逐列保留
    runMigrations(db);
    expect(col('settings_previews', 'import_id').notnull).toBe(0);
    expect(dumpLegacyRows()).toEqual(before);
  });

  it('備份還原：migration 前的備份檔保持 v5 原樣，且以它重新 migrate 得到與原 DB 相同的資料', () => {
    const backupPath = path.join(tempDir, 'backup.sqlite');
    db.prepare('VACUUM INTO ?').run(backupPath);

    runMigrations(db);
    const migrated = dumpLegacyRows();

    const backup = new Database(backupPath);
    try {
      // 備份未被 migration 影響（仍是 v5 schema）
      const importIdCol = (backup.prepare('PRAGMA table_info(settings_previews)').all() as ColInfo[]).find((c) => c.name === 'import_id')!;
      expect(importIdCol.notnull).toBe(1);
      expect((backup.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v).toBe(5);

      // 以備份還原後重新 migrate：資料與原 DB migrate 後逐列相同
      runMigrations(backup);
      expect(backup.prepare('SELECT * FROM settings_previews ORDER BY preview_id').all()).toEqual(migrated.previews);
      expect(backup.prepare('SELECT * FROM idempotency_records ORDER BY idempotency_key').all()).toEqual(migrated.idempotency);
    } finally {
      backup.close();
    }
  });
});
