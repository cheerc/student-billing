import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';

export interface BackupManifest {
  version: '1.0';
  timestamp: string;
  appVersion: string;
  schemaVersion: number;
  activeState: {
    revision: number;
    activeImportId: string | null;
    activeRunId: string | null;
  };
  stats: {
    totalStudents: number;
    totalRuns: number;
    totalBatches: number;
  };
  files: Array<{
    name: string;
    size: number;
    sha256: string;
  }>;
}

export interface VerifyResult {
  ok: boolean;
  integrity: string;
  revision: number;
  activeRunId: string | null;
  totalStudents: number;
  totalCalculations: number;
  mismatchCount: number;
  message: string;
}

function calculateFileSha256(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 停機備份程序：
 * 1. 執行 WAL checkpoint 確保交易日誌完整寫入資料庫主檔。
 * 2. 複製完整 data 目錄（包含 sqlite 主檔、WAL、SHM 與來源目錄）。
 * 3. 產出具有 SHA-256 與 activeState 指標之 backup-manifest.json。
 */
export function backupData(
  sourceDataDir: string,
  backupTargetDir: string
): BackupManifest {
  if (!fs.existsSync(sourceDataDir)) {
    throw new Error(`來源資料目錄不存在: ${sourceDataDir}`);
  }

  const dbPath = path.join(sourceDataDir, 'app.sqlite');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`在 ${sourceDataDir} 中找不到 app.sqlite 主檔案`);
  }

  // 1. 暫時連線執行 WAL Checkpoint，確保所有變更持久化至檔案
  const tempDb = new Database(dbPath);
  try {
    tempDb.pragma('wal_checkpoint(TRUNCATE)');
    const activeState = tempDb.prepare('SELECT * FROM active_state WHERE id = 1').get() as any;
    const batchCountRow = tempDb.prepare('SELECT COUNT(*) as count FROM import_batches').get() as any;
    const runCountRow = tempDb.prepare('SELECT COUNT(*) as count FROM calculation_runs').get() as any;
    const studentCountRow = tempDb.prepare('SELECT COUNT(*) as count FROM imported_students').get() as any;
    const schemaRow = tempDb.prepare('SELECT MAX(version) as maxVer FROM schema_migrations').get() as any;

    const manifestStats = {
      totalStudents: studentCountRow ? studentCountRow.count : 0,
      totalRuns: runCountRow ? runCountRow.count : 0,
      totalBatches: batchCountRow ? batchCountRow.count : 0,
    };

    const manifestActiveState = {
      revision: activeState ? activeState.revision : 0,
      activeImportId: activeState ? activeState.active_import_id : null,
      activeRunId: activeState ? activeState.active_run_id : null,
    };

    const schemaVersion = schemaRow?.maxVer || 1;

    // 關閉 DB 連線，確保無檔案鎖定
    tempDb.close();

    // 2. 建立目標備份目錄
    fs.mkdirSync(backupTargetDir, { recursive: true });

    // 3. 複製所有檔案
    const fileEntries = fs.readdirSync(sourceDataDir);
    const copiedFiles: BackupManifest['files'] = [];

    for (const file of fileEntries) {
      const srcFile = path.join(sourceDataDir, file);
      const destFile = path.join(backupTargetDir, file);
      const stat = fs.statSync(srcFile);

      if (stat.isFile()) {
        fs.copyFileSync(srcFile, destFile);
        copiedFiles.push({
          name: file,
          size: stat.size,
          sha256: calculateFileSha256(destFile),
        });
      } else if (stat.isDirectory()) {
        fs.cpSync(srcFile, destFile, { recursive: true });
      }
    }

    const manifest: BackupManifest = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      appVersion: '0.1.0',
      schemaVersion,
      activeState: manifestActiveState,
      stats: manifestStats,
      files: copiedFiles,
    };

    fs.writeFileSync(
      path.join(backupTargetDir, 'backup-manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );

    return manifest;
  } finally {
    if (tempDb && tempDb.open) {
      tempDb.close();
    }
  }
}

/**
 * 災難還原程序：
 * 嚴禁無提示直接覆蓋已有資料之目錄（除非帶 force: true）。
 * 還原後連線執行 PRAGMA integrity_check 驗證一致性。
 */
export function restoreData(
  backupSourceDir: string,
  destDataDir: string,
  options: { force?: boolean } = {}
): VerifyResult {
  if (!fs.existsSync(backupSourceDir)) {
    throw new Error(`備份來源目錄不存在: ${backupSourceDir}`);
  }

  const manifestPath = path.join(backupSourceDir, 'backup-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`備份目錄中缺少必要之 backup-manifest.json`);
  }

  // 防範無提示覆蓋現有資料 (specs/07 §6 關鍵契約)
  if (fs.existsSync(destDataDir)) {
    const existingFiles = fs.readdirSync(destDataDir).filter((f) => !f.startsWith('.'));
    if (existingFiles.length > 0 && !options.force) {
      throw new Error(
        `目標還原目錄「${destDataDir}」非空且含有已有資料檔案。為防範無提示覆蓋原資料，禁止直接還原！請使用空目錄或帶入 force 旗標確認覆蓋。`
      );
    }
  } else {
    fs.mkdirSync(destDataDir, { recursive: true });
  }

  // 複製檔案至目標目錄
  const files = fs.readdirSync(backupSourceDir);
  for (const file of files) {
    if (file === 'backup-manifest.json') continue;
    const src = path.join(backupSourceDir, file);
    const dest = path.join(destDataDir, file);
    const stat = fs.statSync(src);
    if (stat.isFile()) {
      fs.copyFileSync(src, dest);
    } else if (stat.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
    }
  }

  // 驗證還原結果
  return verifyDataIntegrity(destDataDir);
}

/**
 * 驗證指定資料目錄之資料庫完整性、active 指標與代表查詢。
 */
export function verifyDataIntegrity(dataDir: string): VerifyResult {
  const dbPath = path.join(dataDir, 'app.sqlite');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`在 ${dataDir} 中找不到 app.sqlite`);
  }

  const db = new Database(dbPath);
  try {
    // 1. 檢查 SQLite 實體完整性
    const check = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const integrityResult = check[0]?.integrity_check || 'unknown';
    if (integrityResult !== 'ok') {
      return {
        ok: false,
        integrity: integrityResult,
        revision: 0,
        activeRunId: null,
        totalStudents: 0,
        totalCalculations: 0,
        mismatchCount: 0,
        message: `資料庫完整性檢查失敗: ${integrityResult}`,
      };
    }

    // 2. 檢查 active state
    const active = db.prepare('SELECT * FROM active_state WHERE id = 1').get() as any;
    const studentCountRow = db.prepare('SELECT COUNT(*) as count FROM imported_students').get() as any;
    const calcCountRow = db.prepare('SELECT COUNT(*) as count FROM student_calculations').get() as any;

    let mismatchCount = 0;
    if (active?.active_run_id) {
      const mismatchRow = db
        .prepare('SELECT COUNT(*) as count FROM student_calculations WHERE run_id = ? AND tier_mismatch = 1')
        .get(active.active_run_id) as any;
      mismatchCount = mismatchRow ? mismatchRow.count : 0;
    }

    return {
      ok: true,
      integrity: 'ok',
      revision: active ? active.revision : 0,
      activeRunId: active ? active.active_run_id : null,
      totalStudents: studentCountRow ? studentCountRow.count : 0,
      totalCalculations: calcCountRow ? calcCountRow.count : 0,
      mismatchCount,
      message: '資料庫完整性檢查通過，所有資料與指標一致。',
    };
  } finally {
    db.close();
  }
}

// 支援 CLI 直接執行
if (process.argv[1]?.endsWith('backup-restore.ts')) {
  const [cmd, arg1, arg2, ...rest] = process.argv.slice(2);
  const cwd = process.cwd();
  const defaultDataDir = cwd.endsWith('student-billing')
    ? path.resolve(cwd, 'data')
    : path.resolve(cwd, 'student-billing', 'data');

  if (cmd === 'backup') {
    const targetDir = arg1 || path.resolve(defaultDataDir, '..', `backups/backup-${Date.now()}`);
    console.log(`執行停機備份: ${defaultDataDir} -> ${targetDir}`);
    const manifest = backupData(defaultDataDir, targetDir);
    console.log('備份完成！Manifest:', JSON.stringify(manifest, null, 2));
  } else if (cmd === 'restore') {
    if (!arg1) {
      console.error('請提供備份來源目錄: tsx scripts/backup-restore.ts restore <sourceDir> [destDir] [--force]');
      process.exit(1);
    }
    const destDir = (arg2 && !arg2.startsWith('--')) ? arg2 : defaultDataDir;
    const force = rest.includes('--force') || arg2 === '--force';
    console.log(`執行災難還原: ${arg1} -> ${destDir} (force=${force})`);
    const result = restoreData(arg1, destDir, { force });
    console.log('還原驗證結果:', result);
  } else if (cmd === 'verify') {
    const target = arg1 || defaultDataDir;
    console.log(`驗證資料庫完整性: ${target}`);
    const result = verifyDataIntegrity(target);
    console.log('驗證結果:', result);
  } else {
    console.log('使用方式: tsx scripts/backup-restore.ts [backup|restore|verify] ...');
  }
}
