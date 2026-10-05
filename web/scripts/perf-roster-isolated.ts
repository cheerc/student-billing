import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/adapters/sqlite/migrator.js';
import { saveImportBatch } from '../src/adapters/sqlite/import-repository.js';
import { computeImportRosterChanges } from '../src/application/import-roster-diff.js';
import { summarizeTimings, assertRosterPerformanceBudget } from './perf-contract.js';
import { buildRosterPair, ROSTER_STUDENT_COUNT, ROSTER_NEW_STUDENT_COUNT } from './perf-fixture-roster.js';

/**
 * 逐人異動計算（computeImportRosterChanges）1000ms 獨立量測。
 *
 * 量測邊界：in-process application 路徑 —— 讀 SQLite 兩份名單 → 整批 before/after
 * 計算 → 逐人明細。**不含** HTTP 上傳與瀏覽器 render，也**不是**根 CLAUDE.md:147 的
 * 「完整重算 ≤ 1 秒」（那是 executeCalculationRun 的 gate，見 perf-recompute-isolated.ts）。
 * 1000ms 是逐人異動的既有門檻，與完整重算同數值但不同量測對象。
 *
 * 統計：暖機 1 次後 10 次；median = sorted[4..5] 平均、p95 = nearest-rank
 * ceil(0.95*10)=10（＝最慢一次），定義取自 perf-contract.summarizeTimings，未修改。
 */

function main(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-roster-perf-'));
  const databasePath = path.join(tempDir, 'perf.sqlite');
  try {
    const db = new Database(databasePath);
    runMigrations(db);

    const { before, after } = buildRosterPair();
    const batch = (id: string, createdAt: string, rowCount: number) => ({
      id, fileName: `${id}.xlsx`, fileHash: `hash-${id}`, contentHash: `content-${id}`,
      sheetName: 'Sheet1', headerMap: {}, parserVersion: '1.0.0', scopeNote: '',
      rowCount, status: 'ready' as const, createdAt,
    });
    saveImportBatch(db, batch(before.importId, before.createdAt, before.students.length), before.students);
    saveImportBatch(db, batch(after.importId, after.createdAt, after.students.length), after.students);

    console.log('[perf environment] ' + JSON.stringify({
      cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(),
      os: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version,
      students: ROSTER_STUDENT_COUNT, warmup: 1, samples: 10,
      boundary: 'in-process computeImportRosterChanges: SQLite read → batch diff → per-student detail; no HTTP, no UI render',
      dbStatePerSample: 'same DB, immutable import snapshots; no cache reuse — the function recomputes from scratch each sample',
      median: '(sorted[4]+sorted[5])/2', p95: 'nearest-rank ceil(0.95*10)=10', budget: 'p95 < 1000ms',
    }));

    const warm = computeImportRosterChanges(db, after.importId, before.importId);
    if (warm.newStudents !== ROSTER_NEW_STUDENT_COUNT) {
      throw new Error(`fixture 新增人數 ${warm.newStudents}，預期 ${ROSTER_NEW_STUDENT_COUNT}`);
    }
    if (warm.notAppearedStudents <= 0) throw new Error('fixture 未出現人數為 0');
    if (warm.changedStudents <= 0) throw new Error('fixture 異動人數為 0');
    const expectedTotal = warm.newStudents + warm.notAppearedStudents + warm.changedStudents;
    if (warm.changes.length !== expectedTotal) throw new Error(`changes.length=${warm.changes.length}，預期=${expectedTotal}`);

    const timings: number[] = [];
    for (let run = 0; run < 10; run++) {
      const t0 = performance.now();
      computeImportRosterChanges(db, after.importId, before.importId);
      timings.push(performance.now() - t0);
    }
    const { medianMs, p95Ms } = summarizeTimings(timings);
    console.log('[perf result] ' + JSON.stringify({
      test: 'roster-changes-477',
      changed: warm.changedStudents, new: warm.newStudents, notAppeared: warm.notAppearedStudents,
      samplesMs: timings, medianMs, p95Ms,
    }));
    assertRosterPerformanceBudget(timings);
    console.log(`[perf PASS] roster-changes p95=${p95Ms.toFixed(1)}ms < 1000ms`);
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
