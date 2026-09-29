import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { executeCalculationRun } from '@/application/calculate-run';
import { activateImport } from '@/application/activate-import';
import { queryRunStudents } from '@/application/query-students';
import { generateImportPreview } from '@/application/import-preview';
import { StudentSnapshot } from '@/domain/students';

/**
 * 09 §5.1「人數一行：本班N人 · 符合篩選M人 · N位需確認，標明scope」：
 * stats 的三個計數都必須是**同篩選範圍**，不可拿全批數字冒充「本班」（後者只適用 classScopeTotal）。
 */

const FIXTURE = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');

describe('UX14／09 §5.1：人數行的 scope 標示（stats 同範圍 + 本班基準）', () => {
  let tempDir: string;
  let db: Database.Database;
  let runId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-r4-stats-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);

    const buf = fs.readFileSync(FIXTURE);
    const preview = await generateImportPreview(buf, 'stats-fixture.xlsx');
    saveImportBatch(
      db,
      {
        id: 'imp_stats',
        fileName: 'stats-fixture.xlsx',
        fileHash: preview.fileHash,
        contentHash: preview.contentHash,
        sheetName: preview.sheetName,
        headerMap: preview.headerMapping,
        parserVersion: '1.0.0',
        scopeNote: '',
        rowCount: preview.stats.totalStudents,
        status: 'ready',
        createdAt: new Date().toISOString(),
      },
      preview.students
    );
    const act = activateImport(db, { importId: 'imp_stats', expectedRevision: 0, idempotencyKey: 'stats-1' });
    runId = act.runId;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('無篩選：同範圍人數＝本班基準人數＝全批 477（fixture 實際筆數）', () => {
    const r = queryRunStudents(db, runId, {});
    expect(r.stats.totalStudents).toBe(477);
    // 未選班 → 本班基準與同範圍相同
    expect(r.stats.classScopeTotal).toBe(r.stats.totalStudents);
  });

  it('選班後：「本班N人」＝該班人數，「符合篩選M人」＝同範圍人數（兩者 scope 明確不同）', () => {
    const all = queryRunStudents(db, runId, {});
    const one = queryRunStudents(db, runId, { classId: '國小輔導-四年級A' });

    expect(one.stats.totalStudents).toBeGreaterThan(0);
    expect(one.stats.totalStudents).toBeLessThan(all.stats.totalStudents);
    // 本班基準＝僅套班級條件的人數；此處無其他條件，故與同範圍相同
    expect(one.stats.classScopeTotal).toBe(one.stats.totalStudents);
    // 不可把全批標成本班
    expect(one.stats.classScopeTotal).toBeLessThan(all.stats.totalStudents);
    // 實際回傳筆數與同範圍人數一致（不是全批）
    expect(one.items.length).toBeLessThanOrEqual(one.stats.totalStudents);
  });

  it('班級 + 級距需確認複合篩選：三個計數皆為同範圍', () => {
    const filtered = queryRunStudents(db, runId, {
      classId: '國小輔導-四年級A',
      hasIssues: true,
    });
    const classOnly = queryRunStudents(db, runId, { classId: '國小輔導-四年級A' });

    expect(filtered.stats.totalStudents).toBeLessThanOrEqual(classOnly.stats.totalStudents);
    // issuesCount 是同範圍內需確認的人數，不會超過同範圍總數
    expect(filtered.stats.issuesCount).toBeLessThanOrEqual(filtered.stats.totalStudents);
    // 本班基準不受「需確認」條件影響（scope 只到班級），但不可大於全批
    expect(filtered.stats.classScopeTotal).toBe(classOnly.stats.classScopeTotal);
    expect(filtered.stats.classScopeTotal).toBeLessThanOrEqual(477);
  });

  it('搜尋 q 篩選：人數同步收斂且本班基準不變（q 含個資但計數正確）', () => {
    const q = queryRunStudents(db, runId, { q: 'STU0001' });
    expect(q.stats.totalStudents).toBeGreaterThan(0);
    expect(q.stats.totalStudents).toBeLessThan(477);
    // 未選班 → 本班基準＝全批
    expect(q.stats.classScopeTotal).toBe(477);
  });
});
