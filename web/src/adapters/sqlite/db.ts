import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

/**
 * 取得預設 SQLite 資料庫檔案路徑。
 * 若有環境變數 DATABASE_PATH 則優先採用；
 * 否則指向專案根目錄 data/app.sqlite。
 */
export function getDefaultDatabasePath(): string {
  if (process.env.DATABASE_PATH) {
    return path.resolve(process.env.DATABASE_PATH);
  }

  const cwd = process.cwd();
  if (
    cwd.endsWith('/web') ||
    cwd.endsWith('\\web') ||
    cwd.endsWith('/app') ||
    cwd.endsWith('\\app') ||
    path.basename(cwd) === 'web'
  ) {
    return path.resolve(cwd, '..', 'data', 'app.sqlite');
  }
  return path.resolve(cwd, 'data', 'app.sqlite');
}

/**
 * 建立或開啟 SQLite 資料庫連線。
 * 自動確保父層目錄存在，並配置 WAL 模式與 Foreign Keys。
 */
export function createDatabase(
  dbPath?: string,
  options?: Database.Options
): Database.Database {
  const targetPath = dbPath || getDefaultDatabasePath();
  const dir = path.dirname(targetPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(targetPath, options);

  // 啟用 WAL 模式提高並行讀寫效能與崩潰韌性
  db.pragma('journal_mode = WAL');
  // 強制檢查外部鍵約束
  db.pragma('foreign_keys = ON');
  // 避免並行操作時的鎖定逾時拋錯
  db.pragma('busy_timeout = 5000');

  return db;
}
