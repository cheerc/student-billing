import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { activateImport } from '@/application/activate-import';
import { queryRunStudents } from '@/application/query-students';
import { queryStudentOptions } from '@/application/query-student-options';
import { computeRosterChanges } from '@/application/roster-changes';
import { parseClassTokens, type StudentSnapshot } from '@/domain/students';
import { formatBaseDiscount } from '@/components/summary-table';

function makeStudent(
  personCode: string,
  name: string,
  classesStr: string,
  grade: number | null,
  sourceRow: number,
  tagsRaw = '',
): StudentSnapshot {
  const gradeRaw = grade === null ? '未知' : `${grade}年級`;
  const gradeStatus = grade === null ? 'unavailable' : 'valid';
  return {
    personCode,
    name,
    branch: '北校',
    gradeRaw,
    grade,
    gradeStatus,
    contact: null,
    schoolInfo: null,
    tagsRaw,
    tags: tagsRaw ? tagsRaw.split(/[,;\s]+/).filter(Boolean) : [],
    notesRaw: '',
    enrollments: parseClassTokens(classesStr),
    sourceRow,
  };
}

describe('Round3 PR-F / operator 裁決 d-20261002160111112854-66：無報名學生合計折扣預設 10000', () => {
  let tempDir: string;
  let db: Database.Database;
  let runId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-base-discount-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);

    const students: StudentSnapshot[] = [
      // S1: 無報名學生（科數 null）→ 合計折扣預設 10000（無折扣）
      makeStudent('STU_NO_COURSE', '無報名學生', '', 1, 2),
      // S2: 無報名但有特殊折扣 85 折 → 優先覆蓋為 8500
      makeStudent('STU_SPECIAL', '無報名特殊折扣學生', '', 1, 3, '特殊折扣85折'),
      // S3: 正常 1 科學生 → 合計折扣 10000
      makeStudent('STU_ONE_COURSE', '一科學生成員', '國小數學-一A[團]', 1, 4),
    ];

    saveImportBatch(
      db,
      {
        id: 'imp_base_disc',
        fileName: 'base-disc-fixture.xlsx',
        fileHash: 'hash-base-disc',
        contentHash: 'content-base-disc',
        sheetName: 'Sheet1',
        headerMap: {},
        parserVersion: '1.0.0',
        scopeNote: 'base discount 10000 synthetic',
        rowCount: students.length,
        status: 'ready',
        createdAt: '2026-10-02T00:00:00.000Z',
      },
      students,
    );

    const act = activateImport(db, {
      importId: 'imp_base_disc',
      expectedRevision: 0,
      idempotencyKey: 'act-base-disc',
    });
    runId = act.runId;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('1. 真入口 activate 後查詢：無報名學生 subjectCount 仍為 null，但 baseDiscountBps 為 10000（無折扣）', () => {
    const res = queryRunStudents(db, runId, {});
    const noCourse = res.items.find((s) => s.personCode === 'STU_NO_COURSE')!;
    expect(noCourse).toBeDefined();
    // 科數本身維持 null，不可被改成 0
    expect(noCourse.subjectCount).toBeNull();
    // 合計折扣預設 10000
    expect(noCourse.baseDiscountBps).toBe(10000);
    // 顯示短標自然顯示「無折扣」，不顯示「未設定」
    expect(formatBaseDiscount(noCourse.baseDiscountBps)).toBe('無折扣');
  });

  it('2. 無報名且帶特殊折扣時：特殊折扣優先（85折＝8500）', () => {
    const res = queryRunStudents(db, runId, {});
    const special = res.items.find((s) => s.personCode === 'STU_SPECIAL')!;
    expect(special.subjectCount).toBeNull();
    expect(special.baseDiscountBps).toBe(8500);
    expect(formatBaseDiscount(special.baseDiscountBps)).toBe('85折');
  });

  it('3. options 篩選：合計折扣選項不再包含 ~blank（空白），10000 包含無報名學生', () => {
    const options = queryStudentOptions(db, runId, {});
    const discountOpts = options.options.baseDiscountBps;
    expect(discountOpts).toBeDefined();
    expect(discountOpts.some((o) => o.value === '~blank')).toBe(false);
    const tenThousand = discountOpts.find((o) => o.value === '10000');
    // STU_NO_COURSE 與 STU_ONE_COURSE 均為 10000 → count 應為 2
    expect(tenThousand?.count).toBe(2);
  });

  it('4. 異動明細：學生由 1 科（10000）變更為 0 科（10000）時，合計折扣前後相同，不再列入折扣異動明細', () => {
    const beforeStudent = makeStudent('STU_DROP', '退課學生', '國小數學-一A[團]', 1, 10);
    const afterStudent = makeStudent('STU_DROP', '退課學生', '', 1, 10);
    const result = computeRosterChanges(
      [beforeStudent],
      [afterStudent],
      { scheduleOverride: new Map(), classCategoryMap: new Map() },
      { scheduleOverride: new Map(), classCategoryMap: new Map() }
    );
    expect(result.changes).toHaveLength(1);
    // 折扣未變動（10000 → 10000），discountChange 應為 null
    expect(result.changes[0].discountChange).toBeNull();
    expect(result.stats.discountChangedCount).toBe(0);
  });
});
