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

/**
 * contextual 的第二條觸發分支：只選 applicableDiscountBps（不選 tierMismatch）。
 *
 * `query-student-options.ts:121` 的條件是
 *   key === 'tierMismatch' || (key === 'enrollmentKey' && Boolean(selections.tierMismatch || selections.applicableDiscountBps))
 * PR #73 只鎖了 tierMismatch 一支；此處補 applicableDiscountBps 分支。
 *
 * ── fixture 手算 ──────────────────────────────────────
 * 6 位 grade-1 學生；care 班（國小輔導）適用 anqin 側，數學班取 math、英文班取 english。
 * 適用率（specs/02 R13/R14/R15：非寫功課／非園內生 → 適用率＝基本折扣 R10）：
 *   報名科數 1 → basic 10000；科數 2 → basic 9500；科數 3 → basic 9000。
 *
 * | 學生 | 報名班（類別）                        | 科數 | basic |
 * |------|---------------------------------------|------|-------|
 * | S1   | 一A(care)                             | 1    | 10000 |
 * | S2   | 一A(care), 數學一A(math)              | 2    | 9500  |
 * | S3   | 一A(care), 二A(care), 數學一A(math)   | 2    | 9500  |
 * | S4   | 二A(care)                             | 1    | 10000 |
 * | S5   | 二A(care), 數學一A(math)              | 2    | 9500  |
 * | S6   | 二A(care), 兒童美語KA(english)        | 2    | 9500  |
 *
 * 查 `enrollmentKey=國小輔導-一A` ＋ `applicableDiscountBps=9500` 時，
 * 逐一以**替代班別**（排除 enrollmentKey 本身）重建 predicate：
 * `student-query-predicates.ts:53` 要求恰選一班，故替代班別即該候選班本身，
 * 取該班類別對應的適用率欄；不屬該班的學生不計入。
 *
 *   一A → anqin 欄，值 9500 的學生：S2(9500), S3(9500) = 2
 *   二A → anqin 欄，值 9500 的學生：S3(9500), S5(9500), S6(9500) = 3
 *   數學一A → math 欄，值 9500 的學生：S2, S3, S5 = 3
 *   兒童美語KA → english 欄，值 9500 的學生：S6 = 1
 *
 * 注意二A 的 9500 有三人：適用率是**學生層**的 anqin 欄，不是「該生有沒有上二A」的函數；
 * 只要學生同時报了其他班而科數變成 2，他的 anqin 仍是 9500，只要他报了二A 就會被算進二A 的候選。
 * 同理 S3 同時在一A／二A／數學一A，三個候選都會算他一次。
 *
 * 短路（非 contextual，整批 GROUP BY 不逐候選重建 predicate）時，
 * scope 會退回「排除本欄後套用其餘條件」，此時 applicableDiscountBps 因無單班前提
 * 退化成 `0`，scope 為空集 → 全部候選 count=0，與上述手算 2/2/3/1 不符。
 */
describe('contextual 路徑語意斷言（applicableDiscountBps 觸發分支）', () => {
  let tempDir: string;
  let db: DatabaseType;
  let runId: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-contextual-ad-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);

    const students = [
      { code: 'S1', classes: '國小輔導-一A[團]' },
      { code: 'S2', classes: '國小輔導-一A[團]\n國小數學-一A[團]' },
      { code: 'S3', classes: '國小輔導-一A[團]\n國小輔導-二A[團]\n國小數學-一A[團]' },
      { code: 'S4', classes: '國小輔導-二A[團]' },
      { code: 'S5', classes: '國小輔導-二A[團]\n國小數學-一A[團]' },
      { code: 'S6', classes: '國小輔導-二A[團]\n兒童美語-KA[團]' },
    ];
    const rows = students.map((s, i) => ({
      personCode: s.code, name: `學生${s.code}`,
      branch: '本校', gradeRaw: '1年級', grade: 1, gradeStatus: 'valid' as const,
      contact: null, schoolInfo: null, tagsRaw: '', tags: [] as string[], notesRaw: '',
      sourceRow: i + 2, enrollments: parseClassTokens(s.classes),
    }));
    saveImportBatch(db, {
      id: 'ctx_ad_imp', fileName: 'contextual-ad.xlsx', fileHash: 'ctx-ad-h', contentHash: 'ctx-ad-c',
      sheetName: 'Sheet1', headerMap: {}, parserVersion: '1.0.0', scopeNote: '',
      rowCount: rows.length, status: 'ready' as const, createdAt: '2026-10-04T00:00:00.000Z',
    }, rows);
    const result = activateImport(db, {
      importId: 'ctx_ad_imp', expectedRevision: 0, idempotencyKey: 'ctx-ad-k', asOfDate: '2026-10-04',
    });
    runId = result.runId;
    expect(result.totalStudents).toBe(6);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('只選 applicableDiscountBps 時，enrollmentKey 候選以替代班別的適用率計數', () => {
    const options = queryStudentOptions(db, runId, {
      enrollmentKey: ['國小輔導-一A'],
      applicableDiscountBps: ['9500'],
    });

    const enrollmentKey = new Map(
      options.options.enrollmentKey.map((o) => [o.value, o.count]),
    );

    // 手算見上方表格：各候選班以自身類別欄位計 9500 的學生數。
    expect(enrollmentKey.get('國小輔導-一A')).toBe(2);
    expect(enrollmentKey.get('國小輔導-二A')).toBe(3);
    expect(enrollmentKey.get('國小數學-一A')).toBe(3);
    expect(enrollmentKey.get('兒童美語-KA')).toBe(1);
  });
});
