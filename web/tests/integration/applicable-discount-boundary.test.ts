/**
 * PR #74 審查附註的兩項覆蓋缺口（receipt `review-receipt:m-20261004025945417913-65`）：
 *   (1) `applicableDiscountBps` 只鎖 9500（95折）一值，10000（無折扣）未鎖。
 *   (2) `applicableDiscountBps` 與 `tierMismatch` **同時**選取時的候選計數未覆蓋。
 *
 * 兩項都是**補既有行為的覆蓋**，不是修 bug：實作的適用率與級距比對邏輯本來就正確，
 * 缺的是能鎖住它的測試。下方「為何既有測試沒抓到」逐項說明。
 *
 * ── expected 的獨立來源（CLAUDE.md §8：不得用被測函式輸出回填）────────────
 * 全部依 specs/02 的規則手算，不讀任何產品輸出：
 *
 *   R09（科數）：對整段所屬班級字串，各計一次是否含 `國小輔導`／`國小數學`／`兒童美語`
 *        得到 k；`subjectCount = k - (含寫功課 ? 1 : 0)`。同類兩個班仍算 1 科。
 *   R10（基本折扣）：`effectiveCount = subjectCount + (sibling ? 1 : 0)`；
 *        >2 → 9000、=2 → 9500、其他 → 10000。內部用 basis points。
 *   適用率＝基本折扣（R13／R14：非寫功課、非園內生 → 適用率直接等於 R10 的基本折扣）。
 *
 *   查詢契約（`src/contracts/student-query.ts:122`）：`applicableDiscountBps` **必須**
 *   搭配 `enrollmentKey` 恰選一個班，否則 400。所以「同時選 applicableDiscountBps 與
 *   tierMismatch」的查詢實際上必然是三者並存，本檔的 fixture 依此設計。
 *
 * ── fixture 手算 ──────────────────────────────────────────────────
 * 5 位 grade-1 學生。care 班（國小輔導）對小一取 anqin 側；數學班取 math；英文班取 english。
 * `[5]` 與 `[3_5]` 為該生的米豆奶登記級距，用來製造 match／mismatch。
 *
 * | 學生 | 報名班                                  | 類別      | 科數 | basic | 級距比對（一A）              |
 * |------|-----------------------------------------|-----------|------|-------|----------------------------|
 * | S1   | 一A[5]                                  | care      | 1    | 10000 | match（computed 5 = 5）      |
 * | S2   | 一A[5]                                  | care      | 1    | 10000 | match                       |
 * | S3   | 一A[3_5]、數學一A[5]                     | care+math | 2    | 9500  | mismatch（4.5 ≠ 3.5）       |
 * | S4   | 一A[3_5]、數學一A[5]                     | care+math | 2    | 9500  | mismatch                    |
 * | S5   | 一A[5]、數學一A[3_5]                     | care+math | 2    | 9500  | **mismatch（4.5 ≠ 5）**    |
 *
 * **S5 的一A 也是 mismatch**：報兩班使其 computedTier 為 4.5，而它登記的 `[5]` 是 5。
 * 這一點是本檔 expected 的關鍵，也是最容易手算錯的地方——初稿誤以為 S5 的一A 是 match，
 * 經查 `student_calculations.tier_comparisons` 實際值才更正。
 *
 * | 學生 | 適用率（anqin／math／english） |
 * ||---|
 * | S1 | 10000 / 10000 / 10000 |
 * | S2 | 10000 / 10000 / 10000 |
 * | S3 | 9500 / 9500 / 9500 |
 * | S4 | 9500 / 9500 / 9500 |
 * | S5 | 9500 / 9500 / 9500 |
 *
 * ── (1) 10000（無折扣）邊界值 ────────────────────────────────────
 * 只選 `applicableDiscountBps=10000`（enrollmentKey=一A）時，各候選班以**替代班別**計數
 * （`student-query-predicates.ts:53` 要求恰選一班，故替代班別即該候選班本身，
 * 取該班類別對應的適用率欄）：
 *   一A（anqin 欄，值 10000）：S1, S2 = 2
 *   數學一A（math 欄，值 10000）：S1, S2 也報了一A 但**沒有報數學一A** → 0。
 *   （報數學一A 的是 S3/S4/S5，科數都是 2 → 9500。）
 *
 * ── 為何既有測試沒抓到 ───────────────────────────────────────────
 * `contextual-options.test.ts` 的 applicableDiscountBps describe 只斷 9500，且斷的是
 * 「哪些班有 9500 的學生」——**沒有一條斷言 10000**。若 R10 的 9500 與 10000 被寫反
 * （或 null 被當 10000），該檔仍會全綠，因為它從不查 10000 這個候選值。
 *
 * ── (2) applicableDiscountBps 與 tierMismatch 同選 ────────────────
 * 兩者同時選時，`query-student-options.ts:121` 的 `contextual` 判定讓 **tierMismatch 與
 * enrollmentKey 兩欄都走逐候選重建 predicate**（而非整批 GROUP BY）。
 * 若 contextual flag 漏掉 `applicableDiscountBps` 這條觸發分支，tierMismatch 的計數會
 * 退回「不依班別範圍」的批次計數而算多。
 *
 * 手算（enrollmentKey=一A 為全檔前提）：
 *   applicableDiscountBps=10000 ∧ tierMismatch=true  → 適用率 10000 者為 S1/S2，
 *     而兩人一A 皆 match → 交集 **0**
 *   applicableDiscountBps=9500 ∧ tierMismatch=true   → S3/S4/S5 適用率皆 9500，
 *     且三人的一A 皆 mismatch → 交集 **3**
 *
 * 這兩條合起來鎖住「條件是交集、不是相加或取其一」：若任一條件被忽略，
 * 10000 那條會變成 2、9500 那條會變成 5，兩者都不符。
 */

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

describe('applicableDiscountBps 邊界值與 tierMismatch 同選（PR #74 覆蓋缺口）', () => {
  let tempDir: string;
  let db: DatabaseType;
  let runId: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-applicable-bounds-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);

    // 手算表見檔頭。科數依 R09（國小輔導／國小數學／兒童美語各算一次，同類只算 1 科），
    // 基本折扣依 R10（effectiveCount=科數，=1→10000、=2→9500）。
    const students = [
      // 科數 1 → basic 10000；一A 的 anqin 適用率 10000；[5] 與 computedTier 相同 → match
      { code: 'S1', classes: '國小輔導-一A[團][5]' },
      { code: 'S2', classes: '國小輔導-一A[團][5]' },
      // 科數 2（國小輔導＋國小數學）→ basic 9500；一A 的 anqin 適用率 9500（不是 10000）
      { code: 'S3', classes: '國小輔導-一A[團][3_5]\n國小數學-一A[團][5]' },
      { code: 'S4', classes: '國小輔導-一A[團][3_5]\n國小數學-一A[團][5]' },
      // 科數 2 → basic 9500；一A match、數學一A mismatch
      { code: 'S5', classes: '國小輔導-一A[團][5]\n國小數學-一A[團][3_5]' },
    ];
    const rows = students.map((s, i) => ({
      personCode: s.code, name: `學生${s.code}`,
      branch: '本校', gradeRaw: '1年級', grade: 1, gradeStatus: 'valid' as const,
      contact: null, schoolInfo: null, tagsRaw: '', tags: [] as string[], notesRaw: '',
      sourceRow: i + 2, enrollments: parseClassTokens(s.classes),
    }));
    saveImportBatch(db, {
      id: 'bounds_imp', fileName: 'applicable-bounds.xlsx', fileHash: 'bounds-h',
      contentHash: 'bounds-c', sheetName: 'Sheet1', headerMap: {}, parserVersion: '1.0.0',
      scopeNote: '', rowCount: rows.length, status: 'ready' as const,
      createdAt: '2026-10-04T00:00:00.000Z',
    }, rows);
    const result = activateImport(db, {
      importId: 'bounds_imp', expectedRevision: 0, idempotencyKey: 'bounds-key',
      asOfDate: '2026-10-04',
    });
    runId = result.runId;
    expect(result.totalStudents).toBe(5);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const countsOf = (options: Record<string, Array<{ value: string; count: number }>>, key: string) =>
    new Map((options[key] ?? []).map((o) => [o.value, o.count]));

  describe('(1) 邊界值：10000（無折扣）與 9500（95折）都必須可被查到', () => {
    it('applicableDiscountBps=10000 時，以一A 的 anqin 欄計數（手算 S1, S2 = 2）', () => {
      const options = queryStudentOptions(db, runId, {
        enrollmentKey: ['國小輔導-一A'],
        applicableDiscountBps: ['10000'],
      });

      // 手算：只有科數 1 的 S1／S2 適用率是 10000；S3／S4／S5 科數 2 → 9500。
      expect(countsOf(options.options, 'enrollmentKey').get('國小輔導-一A')).toBe(2);
    });

    it('applicableDiscountBps=9500 時，同一班計數是 3（手算 S3, S4, S5）', () => {
      const options = queryStudentOptions(db, runId, {
        enrollmentKey: ['國小輔導-一A'],
        applicableDiscountBps: ['9500'],
      });

      // 與 10000 那條互補：兩者相加應等於該班的全部報名人數（5 人）。
      expect(countsOf(options.options, 'enrollmentKey').get('國小輔導-一A')).toBe(3);
    });

    it('10000 與 9500 互斥且合計等於全體：同一學生不會同時被兩者命中', () => {
      const at10000 = queryStudentOptions(db, runId, {
        enrollmentKey: ['國小輔導-一A'], applicableDiscountBps: ['10000'],
      });
      const at9500 = queryStudentOptions(db, runId, {
        enrollmentKey: ['國小輔導-一A'], applicableDiscountBps: ['9500'],
      });

      const n10000 = countsOf(at10000.options, 'enrollmentKey').get('國小輔導-一A') ?? 0;
      const n9500 = countsOf(at9500.options, 'enrollmentKey').get('國小輔導-一A') ?? 0;
      // 報名一A 的共 5 人；每人的適用率必為 10000 或 9500 之一，不重不漏。
      expect(n10000 + n9500).toBe(5);
    });

    it('數學班的 math 欄在 9500 上計 2（手算 S3, S4；S5 雖報名但數學一A 為 mismatch 不影響適用率）', () => {
      const options = queryStudentOptions(db, runId, {
        enrollmentKey: ['國小輔導-一A'],
        applicableDiscountBps: ['9500'],
      });

      // 適用率是**學生層**的值（科數 2 → 9500），不是「該生有沒有上某班」的函數：
      // 只要學生報了數學一A，他的 math 適用率就是 9500，故 S3/S4/S5 都算。
      expect(countsOf(options.options, 'enrollmentKey').get('國小數學-一A')).toBe(3);
    });
  });

  describe('(2) applicableDiscountBps 與 tierMismatch 同時選取', () => {
    it('兩個條件同時套用時是交集（手算 0 人），不是相加或取其一', () => {
      const options = queryStudentOptions(db, runId, {
        enrollmentKey: ['國小輔導-一A'],
        applicableDiscountBps: ['10000'],
        tierMismatch: ['true'],
      });

      const tierMismatch = countsOf(options.options, 'tierMismatch');

      // 手算（檔頭說明）：適用率 10000 的是 S1／S2，但兩人的一A 皆 match（computed 5 = 5），
      // 故與 tierMismatch=true 的交集為空。若 applicableDiscountBps 被忽略，會得 2（S1/S2 無
      // mismatch 不會算，故實際會是 0）；若 tierMismatch 被忽略，一A 候選會是 2（S1/S2）。
      expect(tierMismatch.get('true')).toBe(0);
      // false 分支（只有 match、無 mismatch）：S1／S2 適用率 10000 且 match → 命中 2。
      expect(tierMismatch.get('false')).toBe(2);
    });

    it('同選時仍只命中 10000 的兩人（證明條件確實一起生效，而非被忽略）', () => {
      const options = queryStudentOptions(db, runId, {
        enrollmentKey: ['國小輔導-一A'],
        applicableDiscountBps: ['10000'],
        tierMismatch: ['true'],
      });

      // 若 applicableDiscountBps 被忽略（只套 tierMismatch），一A 的 true 會是 2（S3/S4）；
      // 若 tierMismatch 被忽略（只套 10000），會是 2（S1/S2）。兩者皆不等於 0，
      // 故這條斷言能區分「正確的交集 0」與「任一條件被漏掉」。
      expect(countsOf(options.options, 'enrollmentKey').get('國小輔導-一A')).toBe(0);
    });

    it('applicableDiscountBps=9500 搭配 tierMismatch=true：交集是 3（手算 S3, S4, S5）', () => {
      const options = queryStudentOptions(db, runId, {
        enrollmentKey: ['國小輔導-一A'],
        applicableDiscountBps: ['9500'],
        tierMismatch: ['true'],
      });

      // S3／S4／S5 的 anqin 適用率都是 9500，且三人的一A 皆 mismatch：
      //   S3/S4 登記 [3_5]＝3.5 vs computed 4.5；S5 登記 [5]＝5 vs computed 4.5。
      // 適用的 9500 者不只 mismatch 者，故這條的結果是 3（S1／S2 的 10000 被濾掉）。
      expect(countsOf(options.options, 'tierMismatch').get('true')).toBe(3);
    });

    it('contextual 觸發：同時選兩者時 enrollmentKey 候選亦以該班範圍重算', () => {
      const options = queryStudentOptions(db, runId, {
        enrollmentKey: ['國小輔導-一A'],
        applicableDiscountBps: ['9500'],
        tierMismatch: ['true'],
      });

      // 三個條件同時成立的學生 = S3/S4/S5 = 3。若 contextual flag 漏掉
      // applicableDiscountBps 分支而退回批次 GROUP BY，會把適用 10000 的 S1/S2 也算進來
      // （該分支只依 tierMismatch 範圍、不看適用率），故本條對該分支有鑑別力。
      expect(countsOf(options.options, 'enrollmentKey').get('國小輔導-一A')).toBe(3);
    });
  });
});