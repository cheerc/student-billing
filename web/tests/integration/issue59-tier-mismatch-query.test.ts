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
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { migrateLegacyClassSemantics } from '@/domain/classification/legacy-semantic-migration';
import { parseClassTokens, projectLegacyImportTierEvidence, type StudentSnapshot } from '@/domain/students';
import { saveSettings } from '../helpers/d1-test-kit';

/**
 * issue #59 / specs/03-architecture-api.md §127:
 * 「tierMismatch=true 表示選定班／科別範圍內任一 enrollment 為 mismatch；
 *   false 只包含所選範圍內至少一筆 match、沒有 mismatch 或 unavailable 者；
 *   not_applicable 不算 match 也不構成不一致。」
 */

function makeStudent(
  personCode: string,
  name: string,
  classesStr: string,
  grade: number | null,
  sourceRow: number,
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
    tagsRaw: '',
    tags: [],
    notesRaw: '',
    enrollments: parseClassTokens(classesStr).map(projectLegacyImportTierEvidence),
    sourceRow,
  };
}

describe('issue #59 / spec03 §127：tierMismatch 篩選語意對齊（R1–R6）', () => {
  let tempDir: string;
  let db: Database.Database;
  let runId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-issue59-query-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);

    const students: StudentSnapshot[] = [
      // R1: 學生所有 enrollment 皆 not_applicable（非安親班別且無法解析為天數）
      makeStudent('STU_R1', 'R1純不適用學生', '交通車[團]', 1, 2),
      // R2: [not_applicable, match]（一班交通車 not_applicable，一班輔導班 5天吻合）
      makeStudent('STU_R2', 'R2吻合學生', '交通車[團]\n國小輔導-一A[團]', 1, 3),
      // R3: [not_applicable, unavailable]（一班交通車 not_applicable，一班輔導班因年級未知無計算天數）
      makeStudent('STU_R3', 'R3不可用學生', '交通車[團]\n國小輔導-一A[團]', null, 4),
      // R4: 含 mismatch（輔導班宣告4天但一年級計算為5天）
      makeStudent('STU_R4', 'R4不一致學生', '國小輔導-一A[團][4]', 1, 5),
      // R6: 跨兩班（A 班 match、B 班 mismatch）
      makeStudent('STU_R6', 'R6跨班學生', '國小輔導-一A[團]\n國小輔導-一B[團][4]', 1, 6),
    ];

    saveImportBatch(
      db,
      {
        id: 'imp_issue59',
        fileName: 'issue59-fixture.xlsx',
        fileHash: 'hash-issue59',
        contentHash: 'content-issue59',
        sheetName: 'Sheet1',
        headerMap: {},
        parserVersion: '1.0.0',
        scopeNote: 'issue #59 R1-R6 synthetic',
        rowCount: students.length,
        status: 'ready',
        createdAt: '2026-10-02T00:00:00.000Z',
      },
      students,
    );

    // This synthetic historical case models the approved one-time migration: transport has an
    // explicit not-applicable tier semantic, while the seed care class retains its seed meaning.
    const seedDraft = buildSeedDraft();
    const migrated = migrateLegacyClassSemantics(seedDraft.classes, new Map([['交通車', {
      baseName: '交通車',
      migrateSummaryDayRoles: true,
      migrateErpTierApplicability: true,
    }]]));
    saveSettings(db, 'approved-legacy-migration', 1, { ...seedDraft, classes: migrated.classes });

    const act = activateImport(db, {
      importId: 'imp_issue59',
      expectedRevision: 0,
      idempotencyKey: 'act-issue59',
    });
    runId = act.runId;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('R1: 學生所有 enrollment 皆 not_applicable → false 不收錄', () => {
    const resFalse = queryRunStudents(db, runId, { tierMismatch: false });
    const codes = resFalse.items.map((s) => s.personCode);
    expect(codes).not.toContain('STU_R1');
  });

  it('R2: [not_applicable, match] → false 收錄，true 不收錄', () => {
    const resFalse = queryRunStudents(db, runId, { tierMismatch: false });
    const resTrue = queryRunStudents(db, runId, { tierMismatch: true });
    expect(resFalse.items.map((s) => s.personCode)).toContain('STU_R2');
    expect(resTrue.items.map((s) => s.personCode)).not.toContain('STU_R2');
  });

  it('R3: [not_applicable, unavailable] → false 不收錄；true 不收錄', () => {
    const resFalse = queryRunStudents(db, runId, { tierMismatch: false });
    const resTrue = queryRunStudents(db, runId, { tierMismatch: true });
    expect(resFalse.items.map((s) => s.personCode)).not.toContain('STU_R3');
    expect(resTrue.items.map((s) => s.personCode)).not.toContain('STU_R3');
  });

  it('R4: 含 mismatch → false 不收錄、true 收錄', () => {
    const resFalse = queryRunStudents(db, runId, { tierMismatch: false });
    const resTrue = queryRunStudents(db, runId, { tierMismatch: true });
    expect(resFalse.items.map((s) => s.personCode)).not.toContain('STU_R4');
    expect(resTrue.items.map((s) => s.personCode)).toContain('STU_R4');
  });

  it('R5: options 的 tierMismatch 值/計數與 R1–R4 篩選結果一致', () => {
    const options = queryStudentOptions(db, runId, {});
    const falseOption = options.options.tierMismatch?.find((o) => o.value === 'false');
    const trueOption = options.options.tierMismatch?.find((o) => o.value === 'true');
    const resFalse = queryRunStudents(db, runId, { tierMismatch: false });
    const resTrue = queryRunStudents(db, runId, { tierMismatch: true });

    // 依契約推導：僅 R2 吻合（count=1）；R4 與 R6 含 mismatch（count=2）；R1/R3 不得貢獻 false
    expect(falseOption?.count).toBe(1);
    expect(trueOption?.count).toBe(2);
    // options 的計數亦應與 queryRunStudents 篩選結果一致
    expect(falseOption?.count).toBe(resFalse.totalStudents);
    expect(trueOption?.count).toBe(resTrue.totalStudents);
  });

  it('R6: 選班情境（Scope 4）所選班範圍內判定：STU_R6 在 A 班吻合、在 B 班不一致', () => {
    // 全域無選班時：因含 B 班 mismatch，STU_R6 屬 tierMismatch=true，不屬 tierMismatch=false
    const allFalse = queryRunStudents(db, runId, { tierMismatch: false }).items.map((s) => s.personCode);
    const allTrue = queryRunStudents(db, runId, { tierMismatch: true }).items.map((s) => s.personCode);
    expect(allFalse).not.toContain('STU_R6');
    expect(allTrue).toContain('STU_R6');

    // 選 A 班時（所選範圍僅 A 班）：A 班內為 match，故 tierMismatch=false 應收錄、true 不收錄
    const classAFalse = queryRunStudents(db, runId, { enrollmentKey: '國小輔導-一A', tierMismatch: false }).items.map((s) => s.personCode);
    const classATrue = queryRunStudents(db, runId, { enrollmentKey: '國小輔導-一A', tierMismatch: true }).items.map((s) => s.personCode);
    expect(classAFalse).toContain('STU_R6');
    expect(classATrue).not.toContain('STU_R6');

    // 選 B 班時（所選範圍僅 B 班）：B 班內為 mismatch，故 tierMismatch=true 應收錄、false 不收錄
    const classBFalse = queryRunStudents(db, runId, { enrollmentKey: '國小輔導-一B', tierMismatch: false }).items.map((s) => s.personCode);
    const classBTrue = queryRunStudents(db, runId, { enrollmentKey: '國小輔導-一B', tierMismatch: true }).items.map((s) => s.personCode);
    expect(classBFalse).not.toContain('STU_R6');
    expect(classBTrue).toContain('STU_R6');
  });

  it('所選範圍 mismatchCount 與 tierMismatch=true 同源：A 只有 R4，不能算入 R6 的 B 班不一致', () => {
    const scope = queryRunStudents(db, runId, { enrollmentKey: '國小輔導-一A' });
    const mismatches = queryRunStudents(db, runId, { enrollmentKey: '國小輔導-一A', tierMismatch: true });
    expect(mismatches.items.map((s) => s.personCode)).toEqual(['STU_R4']);
    expect(scope.stats.mismatchCount).toBe(1);
    expect(scope.stats.mismatchCount).toBe(mismatches.totalStudents);
    const opts = queryStudentOptions(db, runId, { enrollmentKey: ['國小輔導-一A'] });
    expect(opts.options.tierMismatch.find((o) => o.value === 'true')?.count).toBe(1);
    expect(opts.options.tierMismatch.find((o) => o.value === 'false')?.count).toBe(2);
  });

  it('全run無吻合學生，但跨班學生在選定A班吻合：false值不能從選項宇宙消失', () => {
    const rows = [makeStudent('ONLY', '合成跨班', '國小輔導-一A[團]\n國小輔導-一B[團][4]', 1, 2)];
    saveImportBatch(db, {
      id: 'scope-only', fileName: 'scope-only.xlsx', fileHash: 'scope-only', contentHash: 'scope-only',
      sheetName: 'Sheet1', headerMap: {}, parserVersion: '1', scopeNote: '全合成', rowCount: 1,
      status: 'ready', createdAt: '2026-10-03T00:00:00Z',
    }, rows);
    const id = activateImport(db, { importId: 'scope-only', expectedRevision: 1, idempotencyKey: 'scope-only' }).runId;
    const all = queryStudentOptions(db, id, {});
    const selected = queryStudentOptions(db, id, { enrollmentKey: ['國小輔導-一A'] });
    expect(all.options.tierMismatch.find((o) => o.value === 'false')?.count).toBe(0);
    expect(selected.options.tierMismatch.find((o) => o.value === 'false')?.count).toBe(1);
    expect(selected.options.tierMismatch.find((o) => o.value === 'true')?.count).toBe(0);
  });

  it('issuesCount 等於所選學生範圍內 hasIssues=true；不依 issue enrollmentIds 改歸屬', () => {
    for (const enrollmentKey of ['國小輔導-一A', '國小輔導-一B']) {
      const scope = queryRunStudents(db, runId, { enrollmentKey });
      const issues = queryRunStudents(db, runId, { enrollmentKey, hasIssues: true });
      expect(scope.stats.issuesCount).toBe(issues.totalStudents);
      expect(scope.noCourseTotal).toBe(0);
    }
  });

  it('tierMismatch 同時選取 true 與 false 時依 OR 聯集組合（收錄 R2、R4、R6，不收錄 R1、R3）', () => {
    const resBoth = queryRunStudents(db, runId, { tierMismatch: [true, false] });
    const codes = resBoth.items.map((s) => s.personCode);
    expect(codes).toContain('STU_R2');
    expect(codes).toContain('STU_R4');
    expect(codes).toContain('STU_R6');
    expect(codes).not.toContain('STU_R1');
    expect(codes).not.toContain('STU_R3');
  });
});
