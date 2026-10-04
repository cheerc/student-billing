import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { activateImport } from '@/application/activate-import';
import { queryStudentOptions } from '@/application/query-student-options';
import { parseClassTokens } from '@/domain/students/token-parser';
import { createDatabase } from '@/adapters/sqlite/db';

/**
 * contextual 路徑語意斷言（PR #69 r0 N1 closure）。
 *
 * query-student-options.ts:121 的 `contextual` flag 決定 enrollmentKey 和
 * tierMismatch 候選計數的計算方式：
 *   - contextual=true → 逐候選值建 predicate，tierMismatch 以該班為範圍
 *   - contextual=false → 整批 GROUP BY，不分班範圍
 *
 * 短路成 false 時 enrollmentKey 計數會多算跨班 mismatch 的學生，
 * tierMismatch=false 計數會多算同時有 match 又有 mismatch 的學生。
 *
 * ── fixture 手算 ──────────────────────────────────────
 * 6 位 grade-1 學生、2 個輔導班；computedTier = 5（全員一致）。
 *
 * | 學生 | 報名班                 | tier_comparisons          |
 * |------|------------------------|---------------------------|
 * | S1   | 一A[5], 二A[3_5]       | 一A:match, 二A:mismatch   |
 * | S2   | 一A[5]                 | 一A:match                 |
 * | S3   | 二A[3_5]               | 二A:mismatch              |
 * | S4   | 一A[3_5], 二A[5]       | 一A:mismatch, 二A:match   |
 * | S5   | 一A[3_5]               | 一A:mismatch              |
 * | S6   | 二A[5]                 | 二A:match                 |
 *
 * 查詢 tierMismatch=true 時：
 *   tierMismatch 候選（always contextual）：
 *     true  = S1,S3,S4,S5 = 4（有任一 mismatch）
 *     false = S2,S6       = 2（只有 match，無 mismatch）
 *   enrollmentKey 候選（contextual，因 tierMismatch 已選）：
 *     一A = S4,S5 = 2（一A 本身 mismatch 的人）
 *     二A = S1,S3 = 2（二A 本身 mismatch 的人）
 *
 * 短路 contextual=false 時（batch GROUP BY）：
 *     tierMismatch false = S1,S2,S4,S6 = 4 ← 錯（S1,S4 有 match 但也有 mismatch）
 *     enrollmentKey 一A  = S1,S4,S5    = 3 ← 錯（S1 的 mismatch 在二A 不在一A）
 *     enrollmentKey 二A  = S1,S3,S4    = 3 ← 錯（S4 的 mismatch 在一A 不在二A）
 */

describe('contextual 路徑語意斷言（tierMismatch × enrollmentKey）', () => {
  let tempDir: string;
  let db: DatabaseType;
  let runId: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-contextual-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);

    const students = [
      { code: 'S1', classes: '國小輔導-一A[團][5]\n國小輔導-二A[團][3_5]' },
      { code: 'S2', classes: '國小輔導-一A[團][5]' },
      { code: 'S3', classes: '國小輔導-二A[團][3_5]' },
      { code: 'S4', classes: '國小輔導-一A[團][3_5]\n國小輔導-二A[團][5]' },
      { code: 'S5', classes: '國小輔導-一A[團][3_5]' },
      { code: 'S6', classes: '國小輔導-二A[團][5]' },
    ];
    const rows = students.map((s, i) => ({
      personCode: s.code, name: `學生${s.code}`,
      branch: '本校', gradeRaw: '1年級', grade: 1, gradeStatus: 'valid' as const,
      contact: null, schoolInfo: null, tagsRaw: '', tags: [] as string[], notesRaw: '',
      sourceRow: i + 2, enrollments: parseClassTokens(s.classes),
    }));
    saveImportBatch(db, {
      id: 'ctx_imp', fileName: 'contextual.xlsx', fileHash: 'ctx-hash', contentHash: 'ctx-content',
      sheetName: 'Sheet1', headerMap: {}, parserVersion: '1.0.0', scopeNote: '',
      rowCount: rows.length, status: 'ready' as const, createdAt: '2026-10-04T00:00:00.000Z',
    }, rows);
    const result = activateImport(db, {
      importId: 'ctx_imp', expectedRevision: 0, idempotencyKey: 'ctx-key', asOfDate: '2026-10-04',
    });
    runId = result.runId;
    expect(result.totalStudents).toBe(6);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('tierMismatch=true 時 enrollmentKey 計數以班為範圍（非全域 mismatch）', () => {
    const options = queryStudentOptions(db, runId, { tierMismatch: ['true'] });

    const enrollmentKey = new Map(
      options.options.enrollmentKey.map((o) => [o.value, o.count]),
    );

    // 手算：tierMismatch=true 並以該班為範圍時
    //   一A：S4(一A:mismatch), S5(一A:mismatch) = 2
    //   二A：S1(二A:mismatch), S3(二A:mismatch) = 2
    expect(enrollmentKey.get('國小輔導-一A')).toBe(2);
    expect(enrollmentKey.get('國小輔導-二A')).toBe(2);
  });

  it('tierMismatch 候選的 false 排除同時有 mismatch 的學生', () => {
    const options = queryStudentOptions(db, runId, { tierMismatch: ['true'] });

    const tierMismatch = new Map(
      options.options.tierMismatch.map((o) => [o.value, o.count]),
    );

    // 手算：
    //   true  = S1,S3,S4,S5 = 4（有任一班 mismatch）
    //   false = S2,S6       = 2（只有 match、無 mismatch）
    //   短路 contextual=false 時 false 會多算 S1,S4（有 match 但也有 mismatch）→ 4
    expect(tierMismatch.get('true')).toBe(4);
    expect(tierMismatch.get('false')).toBe(2);
  });
});
