import Database from 'better-sqlite3';
import { runMigrations } from '../src/adapters/sqlite/migrator';
import { saveImportBatch } from '../src/adapters/sqlite/import-repository';
import { activateImport } from '../src/application/activate-import';
import { parseClassTokens, type StudentSnapshot } from '../src/domain/students';
import { assertIsolatedE2eTarget } from './e2e-isolation';

/** 全合成 477 人；班級與級距混合使 contextual 路徑有非空結果，絕不讀真實名冊。 */
export function seedPerformanceDatabase(databasePath: string, port: number): string {
  assertIsolatedE2eTarget({ databasePath, port });
  const db = new Database(databasePath);
  try {
    runMigrations(db);
    const rows: StudentSnapshot[] = Array.from({ length: 477 }, (_, i) => {
      const grade = i % 6 + 1;
      const classes = i % 4 === 0
        ? `國小輔導-一A[團][${i % 8 === 0 ? '3_5' : '5'}]\n國小數學-一A[團]`
        : '國小數學-一A[團]';
      return {
        personCode: `PERF_${String(i).padStart(4, '0')}`, name: `合成學生${i}`,
        grade, gradeRaw: `${grade}年級`, gradeStatus: 'valid', branch: i % 2 ? '南校' : '北校',
        contact: null, schoolInfo: null, tagsRaw: '', tags: [], notesRaw: '',
        sourceRow: i + 2, enrollments: parseClassTokens(classes),
      };
    });
    saveImportBatch(db, {
      id: 'perf_477', fileName: 'synthetic-perf.xlsx', fileHash: 'synthetic-perf-477', contentHash: 'synthetic-perf-477',
      sheetName: 'Sheet1', headerMap: {}, parserVersion: '1.0.0', scopeNote: '全合成效能資料',
      rowCount: rows.length, status: 'ready', createdAt: '2026-10-03T00:00:00.000Z',
    }, rows);
    const result = activateImport(db, { importId: 'perf_477', expectedRevision: 0, idempotencyKey: 'perf-activate', asOfDate: '2026-10-03' });
    if (result.totalStudents !== 477) throw new Error(`fixture 人數錯誤：${result.totalStudents}`);
    return result.runId;
  } finally {
    db.close();
  }
}
