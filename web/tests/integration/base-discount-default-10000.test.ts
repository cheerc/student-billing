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
import { buildClassSettingMap } from '@/application/calculate-run';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
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
  const classSettings = buildClassSettingMap(buildSeedDraft());
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

  it('4. 異動明細：學生由 1 科（10000）變更為 0 科（10000）時，合計折扣前後相同，不再列入合計折扣變動；2 科退為 0 科時顯示「95折 → 無折扣」（非「未設定」）', () => {
    // 4a: 由 1 科無折扣 (10000) 變為 0 科 (10000)
    // 因課程清空適用率由 10000 轉為 null，會列為「適用率變動」，但 discountChange 必為 null（不再誤報已補科數變動「無折扣 → 未設定」）
    const s1Before = makeStudent('STU_DROP_1', '退課學生1', '國小數學-一A[團]', 1, 10);
    const s1After = makeStudent('STU_DROP_1', '退課學生1', '', 1, 10);
    const res1 = computeRosterChanges(
      [s1Before],
      [s1After],
      { scheduleOverride: new Map(), classSettings },
      { scheduleOverride: new Map(), classSettings }
    );
    expect(res1.changes).toHaveLength(1);
    expect(res1.changes[0].reasons).toContain('適用率變動');
    expect(res1.changes[0].reasons).not.toContain('已補科數變動');
    expect(res1.changes[0].discountChange).toBeNull();
    expect(res1.stats.discountChangedCount).toBe(0);

    // 4b: 由 2 科 (9500, 95折) 退為 0 科 (10000, 無折扣)
    // 顯示「95折 → 無折扣」，afterLabel 絕非「未設定」
    const s2Before = makeStudent('STU_DROP_2', '退課學生2', '國小數學-一A[團]\n兒童美語-EA[團]', 1, 11);
    const s2After = makeStudent('STU_DROP_2', '退課學生2', '', 1, 11);
    const res2 = computeRosterChanges(
      [s2Before],
      [s2After],
      { scheduleOverride: new Map(), classSettings },
      { scheduleOverride: new Map(), classSettings }
    );
    expect(res2.changes).toHaveLength(1);
    expect(res2.changes[0].discountChange).toEqual({
      beforeBps: 9500,
      afterBps: 10000,
      beforeLabel: '95折',
      afterLabel: '無折扣',
      reason: '已補科數變動',
    });
    expect(res2.stats.discountChangedCount).toBe(1);
  });
});
