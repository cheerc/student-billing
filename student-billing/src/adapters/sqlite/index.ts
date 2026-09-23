import Database from 'better-sqlite3';
import { createDatabase, getDefaultDatabasePath } from './db';
import { runMigrations } from './migrator';

declare global {
  var __sqlite_db__: Database.Database | undefined;
}

/**
 * 取得應用程式全域 SQLite 資料庫實例。
 * 若尚未連線則建立連線並自動執行未套用的 migrations。
 */
export function getDatabase(): Database.Database {
  if (!global.__sqlite_db__) {
    const db = createDatabase();
    runMigrations(db);
    global.__sqlite_db__ = db;
  }
  return global.__sqlite_db__;
}

export * from './db';
export * from './migrator';
