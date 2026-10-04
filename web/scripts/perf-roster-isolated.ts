import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/adapters/sqlite/migrator.js';
import { saveImportBatch } from '../src/adapters/sqlite/import-repository.js';
import { computeImportRosterChanges } from '../src/application/import-roster-diff.js';
import { summarizeTimings, assertRosterPerformanceBudget } from './perf-contract.js';
import type { StudentSnapshot } from '../src/domain/students/types.js';

const SEED_CLASSES = [
  '國小數學-一A', '國小數學-二A', '國小數學-二B', '國小數學-三A', '國小數學-四A', '國小數學-五A', '國小數學-六A',
  '兒童美語-KA', '兒童美語-KB', '兒童美語-EA', '兒童美語-Gino', '兒童美語-Ali', '兒童美語-Cody',
  '國小輔導-一A', '國小輔導-二A', '國小輔導-三年級', '國小輔導-四年級', '國小輔導-五年級', '國小輔導-六年級',
];

function makeStudent(i: number, extraClasses: string[] = [], dropLast = false): StudentSnapshot {
  const grade = (i % 6) + 1;
  const count = (i % 4) + 1;
  const names: string[] = [];
  for (let k = 0; k < count; k++) names.push(SEED_CLASSES[(i * 7 + k * 5) % SEED_CLASSES.length]);
  const unique = [...new Set(names)];
  if (dropLast && unique.length > 1) unique.pop();
  for (const e of extraClasses) if (!unique.includes(e)) unique.push(e);
  return {
    personCode: `P${String(i).padStart(4, '0')}`,
    name: `學生${i}`,
    branch: '本校',
    gradeRaw: `${grade}年級`,
    grade,
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: i % 11 === 0 ? '有兄弟姊妹折扣' : i % 13 === 0 ? '園內生' : '',
    tags: i % 11 === 0 ? ['有兄弟姊妹折扣'] : i % 13 === 0 ? ['園內生'] : [],
    notesRaw: '',
    enrollments: unique.map((bn) => ({
      rawToken: `${bn}[團]`,
      yearPrefix: null,
      baseName: bn,
      groupFlag: '團',
      modifiers: [],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable',
      parseStatus: 'ok',
    })),
    sourceRow: i + 2,
  };
}

function main(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-roster-perf-'));
  const databasePath = path.join(tempDir, 'perf.sqlite');
  try {
    const db = new Database(databasePath);
    runMigrations(db);

    const N = 477;
    const before: StudentSnapshot[] = [];
    const after: StudentSnapshot[] = [];
    for (let i = 0; i < N; i++) {
      before.push(makeStudent(i));
      if (i % 3 === 0) after.push(makeStudent(i, ['國小數學-三A']));
      else if (i % 10 === 1) after.push(makeStudent(i, [], true));
      else if (i % 47 === 5) continue;
      else after.push(makeStudent(i));
    }
    for (let j = N; j < N + 10; j++) after.push(makeStudent(j));

    const batch = (id: string, createdAt: string, rowCount: number) => ({
      id, fileName: `${id}.xlsx`, fileHash: `hash-${id}`, contentHash: `content-${id}`,
      sheetName: 'Sheet1', headerMap: {}, parserVersion: '1.0.0', scopeNote: '',
      rowCount, status: 'ready' as const, createdAt,
    });
    saveImportBatch(db, batch('imp_perf_base', '2026-09-28T10:00:00.000Z', before.length), before);
    saveImportBatch(db, batch('imp_perf_next', '2026-09-29T10:00:00.000Z', after.length), after);

    console.log('[perf environment] ' + JSON.stringify({
      cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(),
      os: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version,
      students: N, warmup: 1, samples: 10,
      median: '(sorted[4]+sorted[5])/2', p95: 'nearest-rank ceil(0.95*10)=10', budget: 'p95 < 1000ms',
    }));

    const warm = computeImportRosterChanges(db, 'imp_perf_next', 'imp_perf_base');
    if (warm.newStudents !== 10) throw new Error(`fixture 新增人數 ${warm.newStudents}，預期 10`);
    if (warm.notAppearedStudents <= 0) throw new Error('fixture 未出現人數為 0');
    if (warm.changedStudents <= 0) throw new Error('fixture 異動人數為 0');
    const expectedTotal = warm.newStudents + warm.notAppearedStudents + warm.changedStudents;
    if (warm.changes.length !== expectedTotal) throw new Error(`changes.length=${warm.changes.length}，預期=${expectedTotal}`);

    const timings: number[] = [];
    for (let run = 0; run < 10; run++) {
      const t0 = performance.now();
      computeImportRosterChanges(db, 'imp_perf_next', 'imp_perf_base');
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
