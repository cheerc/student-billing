import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { computeImportRosterChanges } from '@/application/import-roster-diff';
import { StudentSnapshot } from '@/domain/students';

/**
 * specs/09 §4／specs/04 UX11：名單差異統計（相對於現行名單的新增／異動／本次未出現）。
 *
 * R4 operator 裁決（d-20260929111803466480-4／-5）：「異動」以 before/after **計算結果**判定
 * （折扣與安親／課輔扣除天數），不再以 person_code ＋ 報名 token 指紋代理。
 * 本檔取代舊的指紋版 computeRosterDiff 測試（舊→新對照見 PR body）：
 *   - 舊「新增或減少 token 計為異動」→ 改為「計費結果有變才算異動」
 *   - 舊「token 順序／重複 token 不算異動」→ 順序仍不算異動（計算結果相同）；重複 token 不再保證，由計算決定
 *   - 新增「報名改但計費不變 → 不算異動」「同報名但年級／標籤變 → 算異動」兩類指紋代理的誤判案例
 *
 * 學生資料經 SQLite 存取（saveImportBatch → 讀回），一併驗證年級與標籤在儲存往返後仍能算出正確的 before/after。
 */

function student(
  personCode: string,
  baseNames: string[],
  opts: { grade?: number; tagsRaw?: string; sourceRow?: number } = {}
): StudentSnapshot {
  const grade = opts.grade ?? 3;
  return {
    personCode,
    name: `學生${personCode}`,
    branch: '本校',
    gradeRaw: `${grade}年級`,
    grade,
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: opts.tagsRaw ?? '',
    tags: opts.tagsRaw ? opts.tagsRaw.split(/[,;\s]+/).filter(Boolean) : [],
    notesRaw: '',
    enrollments: baseNames.map((bn) => ({
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
    sourceRow: opts.sourceRow ?? 1,
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

describe('computeImportRosterChanges：新舊名單差異（以 before/after 計算結果判定）', () => {
  let tempDir: string;
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-roster-diff-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
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

  it('尚無基準名單（baseImportId 為 null）→ 不自我比較，回傳 null 基準、全 0 統計、無明細', () => {
    const incoming = save('imp_new', '2026-09-29T10:00:00.000Z', [student('A', ['國小數學-一A'])]);
    const diff = computeImportRosterChanges(db, incoming, null);
    expect(diff.baseImportId).toBeNull();
    expect(diff.newStudents).toBe(0);
    expect(diff.changedStudents).toBe(0);
    expect(diff.unchangedStudents).toBe(0);
    expect(diff.notAppearedStudents).toBe(0);
    expect(diff.changes).toEqual([]);
  });

  it('基準與本批相同 → 不自我比較（重傳同檔）', () => {
    const same = save('imp_same', '2026-09-29T10:00:00.000Z', [student('A', ['國小數學-一A'])]);
    const diff = computeImportRosterChanges(db, same, same);
    expect(diff.baseImportId).toBeNull();
    expect(diff.changes).toEqual([]);
  });

  it('新增／異動／未異動／未出現各自計數，並帶逐人明細（手算：科數 1→3 折扣 10000→9000）', () => {
    const base = save('imp_base', '2026-09-28T10:00:00.000Z', [
      student('A', ['國小數學-一A']), // 未異動
      student('B', ['國小數學-一A']), // 1 科 → 10000
      student('C', ['國小數學-三A']), // 本次未出現
    ]);
    const incoming = save('imp_next', '2026-09-29T10:00:00.000Z', [
      student('A', ['國小數學-一A']),
      student('B', ['國小數學-一A', '兒童美語-KA', '國小輔導-三年級']), // 3 科 → 9000（R10：>2 科 90%）
      student('D', ['國小數學-三A']), // 新增
    ]);

    const diff = computeImportRosterChanges(db, incoming, base);

    expect(diff.baseImportId).toBe('imp_base');
    expect(diff.newStudents).toBe(1); // D
    expect(diff.changedStudents).toBe(1); // B
    expect(diff.unchangedStudents).toBe(1); // A
    expect(diff.notAppearedStudents).toBe(1); // C

    const byCode = new Map(diff.changes.map((c) => [c.personCode, c]));
    expect([...byCode.keys()].sort()).toEqual(['B', 'C', 'D']);
    expect(byCode.get('B')!.discountChange).toMatchObject({
      beforeBps: 10000,
      afterBps: 9000,
      beforeLabel: '無折扣',
      afterLabel: '9折',
    });
    expect(byCode.get('C')!.isRemoved).toBe(true);
    expect(byCode.get('D')!.isNew).toBe(true);
  });

  it('報名 token 改變但計費結果不變（二A→二B）→ 不算異動（指紋代理會誤判）', () => {
    const base = save('imp_base', '2026-09-28T10:00:00.000Z', [student('A', ['國小數學-二A'], { grade: 1 })]);
    const incoming = save('imp_next', '2026-09-29T10:00:00.000Z', [student('A', ['國小數學-二B'], { grade: 1 })]);

    const diff = computeImportRosterChanges(db, incoming, base);

    expect(diff.changedStudents).toBe(0);
    expect(diff.unchangedStudents).toBe(1);
    expect(diff.changes).toEqual([]);
  });

  it('報名完全相同但年級 1→3 → 算異動（安親→課輔分支；指紋代理會漏判）', () => {
    const base = save('imp_base', '2026-09-28T10:00:00.000Z', [student('A', ['國小輔導-一A'], { grade: 1 })]);
    const incoming = save('imp_next', '2026-09-29T10:00:00.000Z', [student('A', ['國小輔導-一A'], { grade: 3 })]);

    const diff = computeImportRosterChanges(db, incoming, base);

    expect(diff.changedStudents).toBe(1);
    expect(diff.changes[0].personCode).toBe('A');
    expect(diff.changes[0].dayChange).not.toBeNull();
  });

  it('報名相同但標籤加上「有兄弟姊妹折扣」→ 算異動（1 課+兄弟姊妹 10000→9500）', () => {
    const base = save('imp_base', '2026-09-28T10:00:00.000Z', [student('A', ['國小數學-一A'])]);
    const incoming = save('imp_next', '2026-09-29T10:00:00.000Z', [
      student('A', ['國小數學-一A'], { tagsRaw: '有兄弟姊妹折扣' }),
    ]);

    const diff = computeImportRosterChanges(db, incoming, base);

    expect(diff.changedStudents).toBe(1);
    expect(diff.changes[0].discountChange).toMatchObject({ beforeBps: 10000, afterBps: 9500 });
  });

  it('token 順序變動不算異動（計算結果相同）', () => {
    const base = save('imp_base', '2026-09-28T10:00:00.000Z', [
      student('A', ['國小數學-一A', '兒童美語-KA']),
    ]);
    const reordered = save('imp_reorder', '2026-09-29T10:00:00.000Z', [
      student('A', ['兒童美語-KA', '國小數學-一A']),
    ]);

    const diff = computeImportRosterChanges(db, reordered, base);

    expect(diff.changedStudents).toBe(0);
    expect(diff.unchangedStudents).toBe(1);
  });
});
