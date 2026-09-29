import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { computeRosterDiff, saveImportBatch } from '@/adapters/sqlite/import-repository';
import { StudentSnapshot } from '@/domain/students';

/**
 * specs/09 §4／specs/04 UX11：名單差異統計（相對於現行名單的新增／異動／未出現）。
 * 學生身分以 person_code ＋ 排序去重後的報名 token 集合判定；
 * token 順序變動不應被誤判為異動。
 */

function student(personCode: string, tokens: string[], sourceRow = 1): StudentSnapshot {
  return {
    personCode,
    name: `學生${personCode}`,
    branch: '本校',
    gradeRaw: '小一',
    grade: 1,
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: '',
    tags: [],
    notesRaw: '',
    enrollments: tokens.map((rawToken, i) => ({
      rawToken,
      yearPrefix: null,
      baseName: rawToken.replace(/\[.*\]$/, ''),
      groupFlag: '團',
      modifiers: [],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable',
      parseStatus: 'ok',
    })),
    sourceRow,
  };
}

function batch(id: string, createdAt: string) {
  return {
    id,
    fileName: `${id}.xlsx`,
    fileHash: `hash-${id}`,
    contentHash: `content-${id}`,
    sheetName: 'Sheet1',
    headerMap: {},
    parserVersion: '1.0.0',
    scopeNote: '',
    rowCount: 0,
    status: 'ready' as const,
    createdAt,
  };
}

describe('computeRosterDiff：新舊名單差異統計（specs/09 §4）', () => {
  let tempDir: string;
  let dbPath: string;
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-roster-diff-'));
    dbPath = path.join(tempDir, 'test.sqlite');
    db = createDatabase(dbPath);
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const save = (id: string, createdAt: string, students: StudentSnapshot[]) => {
    saveImportBatch(db, { ...batch(id, createdAt), rowCount: students.length }, students);
    return id;
  };

  it('尚無基準名單（baseImportId 為 null）→ 不自我比較，回傳 null 基準與全 0 統計', () => {
    const incoming = save('imp_new', '2026-09-29T10:00:00.000Z', [student('A', ['數學一[團]'])]);
    const diff = computeRosterDiff(db, incoming, null);
    expect(diff.baseImportId).toBeNull();
    expect(diff.newStudents).toBe(0);
    expect(diff.changedStudents).toBe(0);
    expect(diff.notAppearedStudents).toBe(0);
  });

  it('基準與本批相同 → 全部視為未異動（重傳同檔不自我比較）', () => {
    const same = save('imp_same', '2026-09-29T10:00:00.000Z', [student('A', ['數學一[團]'])]);
    const diff = computeRosterDiff(db, same, same);
    expect(diff.baseImportId).toBeNull();
  });

  it('新增／未出現／未異動：逐人比對 person_code + token 集合', () => {
    const base = save('imp_base', '2026-09-28T10:00:00.000Z', [
      student('A', ['數學一[團]']),
      student('B', ['美語二[團]']),
      student('C', ['數學三[團]']),
    ]);
    const incoming = save('imp_next', '2026-09-29T10:00:00.000Z', [
      student('A', ['數學一[團]']), // 未異動
      student('B', ['美語二[團]']), // 未異動
      student('D', ['數學四[團]']), // 新增
    ]);

    const diff = computeRosterDiff(db, incoming, base);
    expect(diff.baseImportId).toBe('imp_base');
    expect(diff.newStudents).toBe(1); // D
    expect(diff.changedStudents).toBe(0);
    expect(diff.unchangedStudents).toBe(2); // A、B
    expect(diff.notAppearedStudents).toBe(1); // C
  });

  it('異動：報名 token 集合改變（新增或減少 token）計為異動', () => {
    const base = save('imp_base', '2026-09-28T10:00:00.000Z', [student('A', ['數學一[團]'])]);
    const added = save('imp_add', '2026-09-29T10:00:00.000Z', [student('A', ['數學一[團]', '美語一[團]'])]);
    expect(computeRosterDiff(db, added, base).changedStudents).toBe(1);

    const removed = save('imp_rm', '2026-09-29T11:00:00.000Z', [student('A', [])]);
    expect(computeRosterDiff(db, removed, base).changedStudents).toBe(1);
  });

  it('token 順序變動不算異動（指紋已排序去重）', () => {
    const base = save('imp_base', '2026-09-28T10:00:00.000Z', [student('A', ['數學一[團]', '美語一[團]'])]);
    const reordered = save('imp_reorder', '2026-09-29T10:00:00.000Z', [student('A', ['美語一[團]', '數學一[團]'])]);
    const diff = computeRosterDiff(db, reordered, base);
    expect(diff.changedStudents).toBe(0);
    expect(diff.unchangedStudents).toBe(1);
  });

  it('重複 token 不影響指紋（去重後比較）', () => {
    const base = save('imp_base', '2026-09-28T10:00:00.000Z', [student('A', ['數學一[團]'])]);
    const dup = save('imp_dup', '2026-09-29T10:00:00.000Z', [student('A', ['數學一[團]', '數學一[團]'])]);
    expect(computeRosterDiff(db, dup, base).changedStudents).toBe(0);
  });
});
