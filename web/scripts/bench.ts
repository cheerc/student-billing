import fs from 'fs';
import path from 'path';
import os from 'os';
import ExcelJS from 'exceljs';
import { createDatabase } from '../src/adapters/sqlite/db';
import { runMigrations } from '../src/adapters/sqlite/migrator';
import { generateImportPreview } from '../src/application/import-preview';
import { saveImportBatch } from '../src/adapters/sqlite/import-repository';
import { activateImport } from '../src/application/activate-import';
import { executeCalculationRun } from '../src/application/calculate-run';
import { saveCalculationRun } from '../src/adapters/sqlite/runs-repository';
import { queryRunStudents } from '../src/application/query-students';
import { readErpWorkbook } from '../src/adapters/xlsx/erp-reader';

interface LatencyStats {
  cold: number;
  warmRuns: number[];
  median: number;
  p95: number;
}

function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function computeStats(cold: number, warm: number[]): LatencyStats {
  const sortedWarm = [...warm].sort((a, b) => a - b);
  const mid = Math.floor(sortedWarm.length / 2);
  const median = sortedWarm.length % 2 === 0
    ? (sortedWarm[mid - 1] + sortedWarm[mid]) / 2
    : sortedWarm[mid];
  const p95 = calculatePercentile(sortedWarm, 95);
  return { cold, warmRuns: warm, median, p95 };
}

export async function runBenchmark() {
  console.log('====================================================');
  console.log('  student-billing P1 效能基準評測 (Performance Bench)');
  console.log('====================================================\n');

  const fixturePath = path.resolve(__dirname, '../tests/fixtures/conforming-erp-fixture.xlsx');
  const fixtureBuf = fs.readFileSync(fixturePath);

  // 建立評測專用獨立臨時目錄
  const benchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bench-'));

  console.log('硬體與環境資訊:');
  console.log(`- 作業系統: ${os.type()} ${os.release()} (${os.arch()})`);
  console.log(`- CPU 核心: ${os.cpus()[0]?.model || 'Apple Silicon'} x ${os.cpus().length}`);
  console.log(`- 記憶體: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`);
  console.log(`- Node.js: ${process.version}`);
  console.log(`- 執行模式: production native module (WAL + strict transaction + full trace)\n`);

  // -------------------------------------------------------------
  // 1. 477 筆真實資料評測 (冷啟動 1 次 + 暖機 10 次)
  // -------------------------------------------------------------
  console.log('--- 1. 477 筆真實資料量測 ---');
  console.log('目標門檻：匯入至可查 < 3.0s (p95)、重算 < 1.0s (p95)、篩選更新 < 200ms (p95)\n');

  const importTimes: number[] = [];
  const recalcTimes: number[] = [];
  const filterTimes: number[] = [];

  let coldImport = 0;
  let coldRecalc = 0;
  let coldFilter = 0;

  for (let i = 0; i <= 10; i++) {
    const isCold = i === 0;
    const testDbPath = path.join(benchDir, `test_477_${i}.sqlite`);
    const db = createDatabase(testDbPath);
    runMigrations(db);

    // A. 匯入至可查結果 (Parse + Save + Activate + First Query)
    const t0 = performance.now();
    const preview = await generateImportPreview(fixtureBuf, `bench_477_${i}.xlsx`);
    saveImportBatch(
      db,
      {
        id: preview.previewId,
        fileName: preview.fileName,
        fileHash: preview.fileHash,
        contentHash: preview.contentHash,
        sheetName: preview.sheetName,
        headerMap: preview.headerMapping,
        parserVersion: '1.0.0',
        scopeNote: preview.scopeNote,
        rowCount: preview.stats.totalStudents,
        status: 'ready',
        createdAt: new Date().toISOString(),
      },
      preview.students
    );
    const actRes = activateImport(db, {
      importId: preview.previewId,
      expectedRevision: 0,
      idempotencyKey: `bench-act-${i}`,
    });
    queryRunStudents(db, actRes.runId, { limit: 50 });
    const importDuration = performance.now() - t0;

    // B. 重算耗時 (Calculate + Save Calculation Results)
    const t1 = performance.now();
    const newRunId = `bench_run_${i}_${Date.now()}`;
    const { run: calcRun, results: calcResults, classCategories } = executeCalculationRun(
      db,
      preview.previewId,
      newRunId
    );
    saveCalculationRun(db, calcRun, calcResults, classCategories);
    const recalcDuration = performance.now() - t1;

    // C. 篩選更新耗時 (執行四種典型篩選查詢取平均)
    const tf0 = performance.now();
    queryRunStudents(db, actRes.runId, { enrollmentKey: '國小輔導-一A[團]' });
    queryRunStudents(db, actRes.runId, { grade: 1 });
    queryRunStudents(db, actRes.runId, { tierMismatch: true });
    queryRunStudents(db, actRes.runId, { q: 'STU0001' });
    const filterDuration = (performance.now() - tf0) / 4;

    db.close();

    if (isCold) {
      coldImport = importDuration;
      coldRecalc = recalcDuration;
      coldFilter = filterDuration;
      console.log(`[冷啟動] 匯入至可查: ${coldImport.toFixed(1)}ms | 重算: ${coldRecalc.toFixed(1)}ms | 篩選更新: ${coldFilter.toFixed(1)}ms`);
    } else {
      importTimes.push(importDuration);
      recalcTimes.push(recalcDuration);
      filterTimes.push(filterDuration);
    }
  }

  const importStats = computeStats(coldImport, importTimes);
  const recalcStats = computeStats(coldRecalc, recalcTimes);
  const filterStats = computeStats(coldFilter, filterTimes);

  console.log('\n477 筆暖機 10 次統計結果:');
  console.log(`- 匯入至可查結果: 中位數 ${importStats.median.toFixed(1)}ms, p95 ${importStats.p95.toFixed(1)}ms (門檻 < 3000ms: ${importStats.p95 < 3000 ? '✓ 達標' : '✗ 未達標'})`);
  console.log(`- 重算與寫入:     中位數 ${recalcStats.median.toFixed(1)}ms, p95 ${recalcStats.p95.toFixed(1)}ms (門檻 < 1000ms: ${recalcStats.p95 < 1000 ? '✓ 達標' : '✗ 未達標'})`);
  console.log(`- 篩選更新延遲:   中位數 ${filterStats.median.toFixed(1)}ms, p95 ${filterStats.p95.toFixed(1)}ms (門檻 < 200ms:  ${filterStats.p95 < 200 ? '✓ 達標' : '✗ 未達標'})\n`);

  // -------------------------------------------------------------
  // 2. 5000 筆合成學生量測 (壓力與無截斷檢驗)
  // -------------------------------------------------------------
  console.log('--- 2. 5000 筆合成學生壓力與延展性量測 ---');
  console.log('正在記憶體合成 5000 筆學生試算表 (XLSX)...');

  const TOTAL_SYNTH = 5000;
  const synthWb = new ExcelJS.Workbook();
  const synthWs = synthWb.addWorksheet('Sheet1');
  synthWs.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);

  for (let i = 1; i <= TOTAL_SYNTH; i++) {
    const code = `STU_5K_${String(i).padStart(6, '0')}`;
    const name = `合成學生${i}`;
    const grade = String((i % 6) + 1);
    const branch = i % 2 === 0 ? '嘉義分校' : '民雄分校';
    const classToken = (i % 3 === 0)
      ? '國小輔導-一A[團]'
      : (i % 3 === 1)
      ? '國小數學-二A[團]'
      : '兒童美語-EA[團]';
    const tag = (i % 10 === 0) ? '有兄弟姊妹折扣' : (i % 15 === 0) ? '園內生' : '';
    synthWs.addRow([code, name, branch, classToken, grade, tag, '合成測試資料']);
  }

  const synthBuf = Buffer.from(await synthWb.xlsx.writeBuffer());
  console.log(`5000 筆 XLSX 大小: ${(synthBuf.length / 1024 / 1024).toFixed(2)} MB`);

  const synthDbPath = path.join(benchDir, 'synth_5000.sqlite');
  const synthDb = createDatabase(synthDbPath);
  runMigrations(synthDb);

  // A. 解析耗時
  const tp0 = performance.now();
  const synthErp = await readErpWorkbook(synthBuf, { fileName: 'synthetic-5000.xlsx' });
  const parse5kDuration = performance.now() - tp0;

  // 驗證無截斷
  if (synthErp.totalRows !== TOTAL_SYNTH || synthErp.students.length !== TOTAL_SYNTH) {
    throw new Error(`5000 筆資料遭截斷！實際讀出: ${synthErp.students.length}`);
  }

  // B. 儲存快照
  const ts0 = performance.now();
  saveImportBatch(
    synthDb,
    {
      id: 'import_synth_5000',
      fileName: 'synthetic-5000.xlsx',
      fileHash: 'synth_5000_hash',
      contentHash: 'synth_5000_content_hash',
      sheetName: 'Sheet1',
      headerMap: synthErp.headers,
      parserVersion: '1.0.0',
      scopeNote: '5000 筆合成資料評測',
      rowCount: synthErp.totalRows,
      status: 'ready',
      createdAt: new Date().toISOString(),
    },
    synthErp.students
  );
  const saveBatchDuration = performance.now() - ts0;

  // C. 全量計算
  const tc0 = performance.now();
  const synthAct = activateImport(synthDb, {
    importId: 'import_synth_5000',
    expectedRevision: 0,
    idempotencyKey: 'bench-5k-act',
  });
  const calc5kDuration = performance.now() - tc0;

  // D. 查詢與分頁
  const tq0 = performance.now();
  const qPage1 = queryRunStudents(synthDb, synthAct.runId, { limit: 50 });
  const qPage2 = queryRunStudents(synthDb, synthAct.runId, { limit: 50, cursor: qPage1.nextCursor || undefined });
  const query5kDuration = (performance.now() - tq0) / 2;

  // E. 篩選耗時
  const tfil0 = performance.now();
  queryRunStudents(synthDb, synthAct.runId, { grade: 2 });
  queryRunStudents(synthDb, synthAct.runId, { enrollmentKey: '國小輔導-一A[團]' });
  queryRunStudents(synthDb, synthAct.runId, { q: 'STU_5K_000100' });
  const filter5kDuration = (performance.now() - tfil0) / 3;

  synthDb.close();

  console.log('\n5000 筆合成量測數據 (無截斷、不崩潰):');
  console.log(`- XLSX 解析耗時:       ${parse5kDuration.toFixed(1)}ms (${(5000 / (parse5kDuration / 1000)).toFixed(0)} 筆/秒)`);
  console.log(`- 批次與報名入庫:     ${saveBatchDuration.toFixed(1)}ms`);
  console.log(`- 5000 筆計算與啟用:   ${calc5kDuration.toFixed(1)}ms (${(5000 / (calc5kDuration / 1000)).toFixed(0)} 筆/秒)`);
  console.log(`- 單頁查詢耗時:       ${query5kDuration.toFixed(1)}ms`);
  console.log(`- 條件篩選耗時:       ${filter5kDuration.toFixed(1)}ms`);
  console.log(`- 驗證結果: 總筆數 ${synthErp.totalRows}，查詢總人數 ${qPage1.totalStudents}，無資料截斷，未發生記憶體溢位。\n`);

  // 清理臨時目錄
  try {
    fs.rmSync(benchDir, { recursive: true, force: true });
  } catch (_e) {}

  // -------------------------------------------------------------
  // 3. 輸出私有報告至 data/reports/bench-report.json (不進版控)
  // -------------------------------------------------------------
  const report = {
    timestamp: new Date().toISOString(),
    environment: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus().length,
      memoryGb: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1),
      nodeVersion: process.version,
    },
    dataset477: {
      totalStudents: 477,
      importToQueryable: importStats,
      recalculate: recalcStats,
      filterLatency: filterStats,
      thresholds: {
        importUnder3s: importStats.p95 < 3000,
        recalcUnder1s: recalcStats.p95 < 1000,
        filterUnder200ms: filterStats.p95 < 200,
      },
    },
    dataset5000: {
      totalStudents: 5000,
      xlsxSizeMb: parseFloat((synthBuf.length / 1024 / 1024).toFixed(2)),
      parseMs: parseFloat(parse5kDuration.toFixed(1)),
      saveBatchMs: parseFloat(saveBatchDuration.toFixed(1)),
      calculateAndActivateMs: parseFloat(calc5kDuration.toFixed(1)),
      queryMs: parseFloat(query5kDuration.toFixed(1)),
      filterMs: parseFloat(filter5kDuration.toFixed(1)),
      noTruncation: true,
      noCrash: true,
    },
  };

  const reportsDir = path.resolve(__dirname, '../../data/reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, 'bench-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`評測報告已產生至私有檔案（受 .gitignore 保護）:`);
  console.log(`  ${reportPath}\n`);
  console.log('====================================================');
  console.log('  P1 效能基準評測完成！');
  console.log('====================================================');

  return report;
}

if (process.argv[1]?.endsWith('bench.ts')) {
  runBenchmark().catch((err) => {
    console.error('評測失敗:', err);
    process.exit(1);
  });
}
