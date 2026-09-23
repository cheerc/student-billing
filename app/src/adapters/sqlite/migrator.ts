import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface MigrationRecord {
  version: number;
  name: string;
  applied_at: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * 取得預設的 SQL migrations 目錄路徑。
 */
export function getDefaultMigrationsDir(): string {
  const cwd = process.cwd();
  if (
    cwd.endsWith('/app') ||
    cwd.endsWith('\\app') ||
    cwd.endsWith('student-billing') ||
    path.basename(cwd) === 'app'
  ) {
    return path.join(cwd, 'src/adapters/sqlite/migrations');
  }
  return path.join(cwd, 'app/src/adapters/sqlite/migrations');
}

/**
 * 確保 schema_migrations 表存在。
 */
export function ensureMigrationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * 查詢所有已套用的 migration 記錄。
 */
export function getAppliedMigrations(db: Database.Database): MigrationRecord[] {
  ensureMigrationTable(db);
  return db
    .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC')
    .all() as MigrationRecord[];
}

/**
 * 執行未套用的 migrations。
 * 採編號 SQL 檔案比對已套用版本，
 * 每個 migration 檔案在獨立 transaction 內執行，
 * 失敗即中止並 rollback，絕不自動刪除 DB 重建。
 */
export function runMigrations(
  db: Database.Database,
  migrationsDir?: string
): MigrationResult {
  ensureMigrationTable(db);

  const dir = migrationsDir || getDefaultMigrationsDir();
  // @ts-ignore
  if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }

  // @ts-ignore
  const rawFiles = fs.readdirSync(/*turbopackIgnore: true*/ dir) as string[];
  const files = rawFiles
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort((a, b) => {
      const verA = parseInt(a.split('_')[0], 10);
      const verB = parseInt(b.split('_')[0], 10);
      return verA - verB;
    });

  const appliedRecords = getAppliedMigrations(db);
  const appliedSet = new Set<number>(appliedRecords.map((r) => r.version));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (appliedSet.has(version)) {
      alreadyApplied.push(file);
      continue;
    }

    // @ts-ignore
    const filePath = path.join(/*turbopackIgnore: true*/ dir, file);
    // @ts-ignore
    const sql = fs.readFileSync(/*turbopackIgnore: true*/ filePath, 'utf-8');

    // 在 transaction 中執行該 migration 與記錄寫入
    const executeMigration = db.transaction((ver: number, name: string, sqlContent: string) => {
      db.exec(sqlContent);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      ).run(ver, name, new Date().toISOString());
    });

    try {
      executeMigration(version, file, sql);
      applied.push(file);
    } catch (error) {
      // better-sqlite3 transaction 自動 rollback
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${file} (v${version}) failed and rolled back: ${message}`);
    }
  }

  return { applied, alreadyApplied };
}
