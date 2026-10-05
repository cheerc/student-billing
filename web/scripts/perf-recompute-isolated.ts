import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../src/adapters/sqlite/db.js';
import { runMigrations } from '../src/adapters/sqlite/migrator.js';
import { saveImportBatch } from '../src/adapters/sqlite/import-repository.js';
import { generateImportPreview } from '../src/application/import-preview.js';
import { activateImport } from '../src/application/activate-import.js';
import { queryRunStudents } from '../src/application/query-students.js';
import { executeCalculationRun, resolveLatestSavedSettings } from '../src/application/calculate-run.js';
import { saveCalculationRun } from '../src/adapters/sqlite/runs-repository.js';
import { resolveFormalRuleSetVersion } from '../src/application/rule-set-resolver.js';
import {
  summarizeTimings, assertRecomputePerformanceBudget, assertImportToQueryablePerformanceBudget,
} from './perf-contract.js';

/**
 * 根 CLAUDE.md:146-147 的兩條 477 人效能驗收標準獨立量測：
 *   - 匯入解析至可查詢 ≤ 3 秒
 *   - 完整重算 ≤ 1 秒
 *
 * 量測邊界（兩條皆 in-process application 路徑，**不含** HTTP 上傳與瀏覽器 render，
 * 與 perf-isolated.ts 的 Chromium 量測是不同契約）：
 *   - 匯入至可查：原始 XLSX 內容 → generateImportPreview（解析）→ saveImportBatch
 *     → activateImport（executeCalculationRun ＋ saveCalculationRun ＋ 切 active）
 *     → queryRunStudents 可查詢。
 *   - 完整重算：既有已啟用 run 的 import 快照 → executeCalculationRun ＋
 *     saveCalculationRun，寫入**新的** runId（不覆寫既有 run）。
 *
 * 原子性與 trace 均未關閉（走產品預設路徑，不傳任何關閉選項）。
 * 每個樣本用**不同的 DB 檔**（全新 migrate ＋ 重新匯入），因此不存在跨樣本 cache 命中
 * 或前一樣本計算結果被重用的可能。**migrate 不在計時窗內**：`freshDatabase()`（含
 * `runMigrations`）在 `performance.now()` 起算之前完成，實際量測窗為
 * 匯入路徑的 parse → save → activate → query，重算路徑則為 executeCalculationRun ＋
 * saveCalculationRun。門檻契約（specs/07 T07「477 筆匯入至可查結果 3 秒內」）是使用者
 * 點上傳後的目標；schema migrate 是一次性的 DB 準備步驟，不屬於每次使用者的等待時間。
 */

const FIXTURE = path.resolve(import.meta.dirname, '../tests/fixtures/conforming-erp-fixture.xlsx');
const EXPECTED_STUDENTS = 477;

function freshDatabase(dir: string, index: number): ReturnType<typeof createDatabase> {
  const db = createDatabase(path.join(dir, `gate-${index}.sqlite`));
  runMigrations(db);
  return db;
}

/** 匯入至可查：原始內容 → 解析 → 儲存 → 啟用（計算＋持久化）→ 可查詢。 */
async function measureImportToQueryable(fixtureBuf: Buffer, dir: string, index: number) {
  const db = freshDatabase(dir, index);
  const started = performance.now();
  const preview = await generateImportPreview(fixtureBuf, `gate-import-${index}.xlsx`);
  saveImportBatch(db, {
    id: `gate_imp_${index}`, fileName: `gate-import-${index}.xlsx`,
    fileHash: preview.fileHash, contentHash: preview.contentHash, sheetName: preview.sheetName,
    headerMap: preview.headerMapping, parserVersion: '1.0.0', scopeNote: preview.scopeNote,
    rowCount: preview.stats.totalStudents, status: 'ready', createdAt: new Date().toISOString(),
  }, preview.students);
  const activation = activateImport(db, {
    importId: `gate_imp_${index}`, expectedRevision: 0, idempotencyKey: `gate-imp-act-${index}`,
    asOfDate: '2026-10-04',
  });
  const queried = queryRunStudents(db, activation.runId, { limit: 50 });
  const ms = performance.now() - started;

  // 非空轉：解析不截斷、run 可查、人數一致。
  if (preview.stats.totalStudents !== EXPECTED_STUDENTS) {
    throw new Error(`解析人數 ${preview.stats.totalStudents}，預期 ${EXPECTED_STUDENTS}`);
  }
  if (activation.totalStudents !== EXPECTED_STUDENTS) {
    throw new Error(`重算人數 ${activation.totalStudents}，預期 ${EXPECTED_STUDENTS}`);
  }
  if (queried.totalStudents !== EXPECTED_STUDENTS || queried.items.length === 0) {
    throw new Error(`可查人數 ${queried.totalStudents}／${queried.items.length} 與預期不符`);
  }
  db.close();
  return ms;
}

/** 完整重算：讀既有 import 快照 → executeCalculationRun → saveCalculationRun（新 runId）。 */
function measureRecompute(db: Database.Database, importId: string, index: number) {
  const runId = `gate_recompute_${index}`;
  const started = performance.now();
  const { run, results, classCategories } = executeCalculationRun(db, importId, runId, {
    ruleSetVersion: resolveFormalRuleSetVersion(db),
    asOfDate: '2026-10-04',
    ...resolveLatestSavedSettings(db),
  });
  saveCalculationRun(db, run, results, classCategories);
  const ms = performance.now() - started;

  // 非空轉：結果筆數與學生數一致，且新 run 真的可查。
  if (results.length !== EXPECTED_STUDENTS) {
    throw new Error(`重算結果 ${results.length} 筆，預期 ${EXPECTED_STUDENTS}`);
  }
  if (run.totalStudents !== EXPECTED_STUDENTS) {
    throw new Error(`run.totalStudents=${run.totalStudents}，預期 ${EXPECTED_STUDENTS}`);
  }
  const queried = queryRunStudents(db, runId, { limit: 50 });
  if (queried.totalStudents !== EXPECTED_STUDENTS || queried.items.length === 0) {
    throw new Error(`重算後不可查：${queried.totalStudents}／${queried.items.length}`);
  }
  return ms;
}

async function main(): Promise<void> {
  const fixtureBuf = fs.readFileSync(FIXTURE);
  const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-gate-import-'));
  const recomputeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-gate-recompute-'));
  try {
    console.log('[perf environment] ' + JSON.stringify({
      cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(),
      os: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version,
      students: EXPECTED_STUDENTS, fixture: 'tests/fixtures/conforming-erp-fixture.xlsx（全合成 477 列）',
      warmup: 1, samples: 10,
      boundary: 'in-process application paths; no HTTP upload, no UI render. import: raw xlsx → parse → save → activate(calculate+persist) → query. recompute: import snapshot → executeCalculationRun + saveCalculationRun → query.',
      dbStatePerSample: 'fresh DB per sample (new file, migrations re-run, import re-parsed) — no cache hit, no reuse of a previous sample\'s run',
      integrity: 'atomicity and full trace left at product defaults; nothing disabled for speed',
      median: '(sorted[4]+sorted[5])/2', p95: 'nearest-rank ceil(0.95*10)=10',
      budgets: 'import-to-queryable p95 < 3000ms; full recompute p95 < 1000ms',
    }));

    // 暖機：兩條各一次，不計入樣本。
    await measureImportToQueryable(fixtureBuf, importDir, -1);
    const warmDb = freshDatabase(recomputeDir, -1);
    const warmPreview = await generateImportPreview(fixtureBuf, 'gate-warm.xlsx');
    saveImportBatch(warmDb, {
      id: 'gate_warm_imp', fileName: 'gate-warm.xlsx', fileHash: warmPreview.fileHash,
      contentHash: warmPreview.contentHash, sheetName: warmPreview.sheetName,
      headerMap: warmPreview.headerMapping, parserVersion: '1.0.0', scopeNote: warmPreview.scopeNote,
      rowCount: warmPreview.stats.totalStudents, status: 'ready', createdAt: new Date().toISOString(),
    }, warmPreview.students);
    activateImport(warmDb, {
      importId: 'gate_warm_imp', expectedRevision: 0, idempotencyKey: 'gate-warm-act', asOfDate: '2026-10-04',
    });
    measureRecompute(warmDb, 'gate_warm_imp', -1);
    warmDb.close();

    const importSamples: number[] = [];
    for (let i = 0; i < 10; i++) importSamples.push(await measureImportToQueryable(fixtureBuf, importDir, i));
    const importStats = summarizeTimings(importSamples);

    // 完整重算的 10 個樣本共用一個已匯入的 DB：重算的量測對象是「讀快照→計算→持久化」，
    // 不含匯入；每個樣本寫入**不同 runId**，故前一樣本的計算結果不可能被命中或重用。
    const recomputeDb = freshDatabase(recomputeDir, 100);
    const recomputePreview = await generateImportPreview(fixtureBuf, 'gate-recompute.xlsx');
    saveImportBatch(recomputeDb, {
      id: 'gate_recompute_imp', fileName: 'gate-recompute.xlsx', fileHash: recomputePreview.fileHash,
      contentHash: recomputePreview.contentHash, sheetName: recomputePreview.sheetName,
      headerMap: recomputePreview.headerMapping, parserVersion: '1.0.0', scopeNote: recomputePreview.scopeNote,
      rowCount: recomputePreview.stats.totalStudents, status: 'ready', createdAt: new Date().toISOString(),
    }, recomputePreview.students);
    activateImport(recomputeDb, {
      importId: 'gate_recompute_imp', expectedRevision: 0, idempotencyKey: 'gate-recompute-act', asOfDate: '2026-10-04',
    });
    const recomputeSamples: number[] = [];
    for (let i = 0; i < 10; i++) recomputeSamples.push(measureRecompute(recomputeDb, 'gate_recompute_imp', i));
    recomputeDb.close();
    const recomputeStats = summarizeTimings(recomputeSamples);

    console.log('[perf result] ' + JSON.stringify({
      test: 'import-to-queryable-477', samplesMs: importSamples, ...importStats,
    }));
    assertImportToQueryablePerformanceBudget(importSamples);
    console.log(`[perf PASS] import-to-queryable p95=${importStats.p95Ms.toFixed(1)}ms < 3000ms`);

    console.log('[perf result] ' + JSON.stringify({
      test: 'full-recompute-477', samplesMs: recomputeSamples, ...recomputeStats,
    }));
    assertRecomputePerformanceBudget(recomputeSamples);
    console.log(`[perf PASS] full-recompute p95=${recomputeStats.p95Ms.toFixed(1)}ms < 1000ms`);
  } finally {
    fs.rmSync(importDir, { recursive: true, force: true });
    fs.rmSync(recomputeDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
