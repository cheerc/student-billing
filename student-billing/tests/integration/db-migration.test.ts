import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { createDatabase, getDefaultDatabasePath } from '@/adapters/sqlite/db';
import { runMigrations, getAppliedMigrations } from '@/adapters/sqlite/migrator';

describe('SQLite Migration Integration Tests', () => {
  let tempDir: string;
  let tempDbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-db-'));
    tempDbPath = path.join(tempDir, 'test.sqlite');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('1. 預設資料庫路徑應為 student-billing/data/app.sqlite', () => {
    const defaultPath = getDefaultDatabasePath();
    expect(defaultPath).toMatch(/student-billing\/data\/app\.sqlite$/);
  });

  it('2. 應能在獨立臨時路徑建檔並成功套用初始 migration', () => {
    const db = createDatabase(tempDbPath);
    expect(fs.existsSync(tempDbPath)).toBe(true);

    const result = runMigrations(db);
    expect(result.applied).toContain('0001_init.sql');

    // 驗證 schema_migrations
    const applied = getAppliedMigrations(db);
    expect(applied).toHaveLength(1);
    expect(applied[0].version).toBe(1);
    expect(applied[0].name).toBe('0001_init.sql');

    // 驗證 active_state 表與初始值
    const activeState = db.prepare('SELECT * FROM active_state WHERE id = 1').get() as {
      id: number;
      active_import_id: string | null;
      active_run_id: string | null;
      revision: number;
    };
    expect(activeState).toBeDefined();
    expect(activeState.revision).toBe(0);
    expect(activeState.active_import_id).toBeNull();
    expect(activeState.active_run_id).toBeNull();

    // 驗證 import_batches 表存在
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='import_batches'").get();
    expect(tableCheck).toBeDefined();

    db.close();
  });

  it('3. 重開 DB 後重跑 migration 應具備冪等性，不重複執行', () => {
    // 第一次執行 migration
    const db1 = createDatabase(tempDbPath);
    const result1 = runMigrations(db1);
    expect(result1.applied).toContain('0001_init.sql');
    db1.close();

    // 重新打開同一個 DB
    const db2 = createDatabase(tempDbPath);
    const result2 = runMigrations(db2);
    expect(result2.applied).toHaveLength(0);
    expect(result2.alreadyApplied).toContain('0001_init.sql');

    const applied = getAppliedMigrations(db2);
    expect(applied).toHaveLength(1);
    expect(applied[0].version).toBe(1);

    db2.close();
  });

  it('4. migration 失敗時應中止並 rollback，絕不自動刪除 DB 重建', () => {
    const db = createDatabase(tempDbPath);
    runMigrations(db);

    // 建立臨時 migration 目錄，包含一個成功 migration 與一個會失敗的 migration
    const customMigrationsDir = path.join(tempDir, 'migrations');
    fs.mkdirSync(customMigrationsDir, { recursive: true });

    // 0002 有效 migration
    fs.writeFileSync(
      path.join(customMigrationsDir, '0002_good.sql'),
      'CREATE TABLE test_good (id INTEGER PRIMARY KEY);'
    );
    // 0003 錯誤 migration (語法錯誤)
    fs.writeFileSync(
      path.join(customMigrationsDir, '0003_bad.sql'),
      'CREATE TABLE test_bad (id INTEGER PRIMARY KEY); INVALID SQL SYNTAX HERE;'
    );

    // 執行自訂 migration，預期在 0003 拋出例外
    expect(() => {
      runMigrations(db, customMigrationsDir);
    }).toThrow();

    // 驗證 0002 成功套用
    const applied = getAppliedMigrations(db);
    expect(applied.map(m => m.name)).toContain('0002_good.sql');
    expect(applied.map(m => m.name)).not.toContain('0003_bad.sql');

    // 驗證 0003 中的 test_bad 表因為 rollback 而不存在
    const badTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_bad'").get();
    expect(badTable).toBeUndefined();

    // 驗證資料庫檔案依然存在且可用（絕對沒有被刪除重建）
    expect(fs.existsSync(tempDbPath)).toBe(true);
    const activeState = db.prepare('SELECT * FROM active_state WHERE id = 1').get();
    expect(activeState).toBeDefined();

    db.close();
  });
});
