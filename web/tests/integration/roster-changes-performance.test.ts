import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { computeImportRosterChanges } from '@/application/import-roster-diff';
import { buildRosterPair, ROSTER_NEW_STUDENT_COUNT } from '../../scripts/perf-fixture-roster';

/**
 * 逐人異動計算的**行為**契約（477 人合成名單，結果必須是真實計算不是空轉）。
 *
 * 1000ms 計時 gate 已依根 CLAUDE.md:149「效能門檻量測條件」（單檔、不與其他測試檔並行、
 * 記錄環境）移出預設並行 suite，改由 `npm run test:perf:roster-isolated`
 * （scripts/perf-roster-isolated.ts，CI 序列執行）承載。
 * 本檔保留可攜帶的正確性斷言——它們不量時間，因此在並行 suite 下仍然有意義。
 *
 * fixture 與 runner 共用 scripts/perf-fixture-roster.ts，避免兩份名冊靜默漂移
 * （使 1000ms gate 量到與此斷言不同的資料集）。
 */

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

describe('整批名單異動計算正確性（477 人合成名單）', () => {
  let tempDir: string;
  let db: ReturnType<typeof createDatabase>;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-roster-perf-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);

    const { before, after } = buildRosterPair();
    saveImportBatch(db, batch(before.importId, before.createdAt, before.students.length), before.students);
    saveImportBatch(db, batch(after.importId, after.createdAt, after.students.length), after.students);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('477 人整批 before/after 計算（含讀 DB、逐人明細）涵蓋加課、退課、新增、未出現四類異動', () => {
    const result = computeImportRosterChanges(db, 'imp_perf_next', 'imp_perf_base');
    // 結果必須是真實計算，不是空轉：加課／退課／新增／未出現都要有
    expect(result.newStudents).toBe(ROSTER_NEW_STUDENT_COUNT);
    expect(result.notAppearedStudents).toBeGreaterThan(0);
    expect(result.changedStudents).toBeGreaterThan(0);
    expect(result.changes.length).toBe(result.newStudents + result.notAppearedStudents + result.changedStudents);
  });
});