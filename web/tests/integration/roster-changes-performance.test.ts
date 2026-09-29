import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { computeImportRosterChanges } from '@/application/import-roster-diff';
import { StudentSnapshot } from '@/domain/students';

/**
 * 效能驗收（根 CLAUDE.md §8：477 人資料量、完整重算 ≤ 1 秒）。
 *
 * Lead rework 派工要求「整批接入後重新實測」：先前量到的 3.9ms 只是單人呼叫，不是整批。
 * 本測試走**產品實際路徑**（從 SQLite 讀兩份名單 → 讀最新已儲存設定 → 整批 before/after 計算 → 逐人明細），
 * 以 477 人合成名單（保形匿名，不含真實個資）暖機後量 10 次，門檻取最慢一次（≥ p95）＜ 1000 ms。
 */

const SEED_CLASSES = [
  '國小數學-一A', '國小數學-二A', '國小數學-二B', '國小數學-三A', '國小數學-四A', '國小數學-五A', '國小數學-六A',
  '兒童美語-KA', '兒童美語-KB', '兒童美語-EA', '兒童美語-Gino', '兒童美語-Ali', '兒童美語-Cody',
  '國小輔導-一A', '國小輔導-二A', '國小輔導-三年級', '國小輔導-四年級', '國小輔導-五年級', '國小輔導-六年級',
];

function makeStudent(i: number, extraClasses: string[] = [], dropLast = false): StudentSnapshot {
  const grade = (i % 6) + 1;
  const count = (i % 4) + 1; // 1–4 門課
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

const batch = (id: string, createdAt: string, rowCount: number) => ({
  id,
  fileName: `${id}.xlsx`,
  fileHash: `hash-${id}`,
  contentHash: `content-${id}`,
  sheetName: 'Sheet1',
  headerMap: {},
  parserVersion: '1.0.0',
  scopeNote: '',
  rowCount,
  status: 'ready' as const,
  createdAt,
});

describe('整批名單異動計算效能（477 人，門檻 ≤ 1 秒）', () => {
  let tempDir: string;
  let db: ReturnType<typeof createDatabase>;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-roster-perf-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);

    const N = 477;
    const before: StudentSnapshot[] = [];
    const after: StudentSnapshot[] = [];
    for (let i = 0; i < N; i++) {
      before.push(makeStudent(i));
      if (i % 3 === 0) after.push(makeStudent(i, ['國小數學-三A'])); // 約 1/3 加課
      else if (i % 10 === 1) after.push(makeStudent(i, [], true)); // 約 1/10 退課
      else if (i % 47 === 5) continue; // 約 2% 未出現
      else after.push(makeStudent(i));
    }
    for (let j = N; j < N + 10; j++) after.push(makeStudent(j)); // 10 位新增

    saveImportBatch(db, batch('imp_perf_base', '2026-09-28T10:00:00.000Z', before.length), before);
    saveImportBatch(db, batch('imp_perf_next', '2026-09-29T10:00:00.000Z', after.length), after);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('477 人整批 before/after 計算（含讀 DB、逐人明細）暖機後 10 次，最慢一次 < 1000 ms', () => {
    // 暖機（JIT、prepared statement）
    const warm = computeImportRosterChanges(db, 'imp_perf_next', 'imp_perf_base');
    // 結果必須是真實計算，不是空轉：加課／退課／新增／未出現都要有
    expect(warm.newStudents).toBe(10);
    expect(warm.notAppearedStudents).toBeGreaterThan(0);
    expect(warm.changedStudents).toBeGreaterThan(0);
    expect(warm.changes.length).toBe(warm.newStudents + warm.notAppearedStudents + warm.changedStudents);

    const timings: number[] = [];
    for (let run = 0; run < 10; run++) {
      const t0 = performance.now();
      computeImportRosterChanges(db, 'imp_perf_next', 'imp_perf_base');
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)];
    const slowest = timings[timings.length - 1];
    // 實測數字供 report 引用
    console.info(
      `[perf] computeImportRosterChanges 477人 整批: median=${median.toFixed(1)}ms slowest=${slowest.toFixed(1)}ms ` +
        `(changed=${warm.changedStudents} new=${warm.newStudents} notAppeared=${warm.notAppearedStudents})`
    );

    expect(slowest).toBeLessThan(1000);
  });
});
