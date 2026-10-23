import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { activateImport } from '@/application/activate-import';
import { parseClassTokens, type StudentSnapshot } from '@/domain/students';
import { GET } from '@/app/api/v1/runs/[runId]/students/route';

const MATH = '國小數學-一A';
const CARE = '國小輔導-一A';

function student(code: string, grade: number | null, classes: string, over: Partial<StudentSnapshot> = {}): StudentSnapshot {
  return {
    personCode: code, name: `合成${code}`, branch: '北校', grade, gradeRaw: grade === null ? '未知' : `${grade}年級`,
    gradeStatus: grade === null ? 'unavailable' : 'valid', contact: null, schoolInfo: null,
    tagsRaw: '', tags: [], notesRaw: '', enrollments: parseClassTokens(classes), sourceRow: 2, ...over,
  };
}

/** 合成名冊→activate→真正 students GET；expected 依明列集合獨立計數。 */
describe('Excel 式各欄選項：其他欄 AND、自欄排除、全 run 值宇宙', () => {
  let tempDir: string;
  let runId: string;
  let issueRunId: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-excel-options-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    global.__sqlite_db__?.close();
    global.__sqlite_db__ = undefined;
    const rows = [
      student('A', 1, `${MATH}[團]`),
      student('B', 2, `${MATH}[團]\n${MATH}[團][W1]\n${CARE}[團]`, { tagsRaw: '特殊折扣85折', tags: ['特殊折扣85折'] }),
      student('C', 3, `${CARE}[團]`),
      student('D', null, '', { branch: null }),
      student('E', 4, '[團]'),
      student('F', 5, '合成未知班[團]'),
      student('G', 1, `${MATH}[團]`, { branch: '北校\n南校' }),
    ];
    saveImportBatch(getDatabase(), {
      id: 'excel-options', fileName: 'synthetic.xlsx', fileHash: 'excel-options-file', contentHash: 'excel-options-content',
      sheetName: 'Sheet1', headerMap: {}, parserVersion: '1', scopeNote: '全合成', rowCount: rows.length,
      status: 'ready', createdAt: '2026-10-03T00:00:00Z',
    }, rows);
    runId = activateImport(getDatabase(), { importId: 'excel-options', expectedRevision: 0, idempotencyKey: 'excel-options' }).runId;
    // H 有員工家屬無折扣問題（R18），I 的數學一A課表存在無問題。
    const issueRows = [{ ...student('H', 2, `${MATH}[團]`), tagsRaw: '員工家屬', tags: ['員工家屬'] }, student('I', 3, `${MATH}[團]`)];
    saveImportBatch(getDatabase(), {
      id: 'excel-issues', fileName: 'synthetic.xlsx', fileHash: 'excel-issues-file', contentHash: 'excel-issues-content',
      sheetName: 'Sheet1', headerMap: {}, parserVersion: '1', scopeNote: '全合成', rowCount: issueRows.length,
      status: 'ready', createdAt: '2026-10-03T00:00:00Z',
    }, issueRows);
    issueRunId = activateImport(getDatabase(), { importId: 'excel-issues', expectedRevision: 1, idempotencyKey: 'excel-issues' }).runId;
  });
  afterEach(() => {
    global.__sqlite_db__?.close();
    global.__sqlite_db__ = undefined;
    delete process.env.DATABASE_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  async function query(params: Record<string, string | string[]> = {}, targetRun = runId) {
    const search = new URLSearchParams();
    for (const [key, values] of Object.entries(params)) for (const value of [values].flat()) search.append(key, value);
    const response = await GET(new NextRequest(`http://127.0.0.1:3512/api/v1/runs/${targetRun}/students?${search}`), { params: Promise.resolve({ runId: targetRun }) });
    return { status: response.status, body: await response.json() };
  }
  const counts = (body: any, key: string) => Object.fromEntries(body.options[key].map((o: { value: string; count: number }) => [o.value, o.count]));

  it('選數學後 grade 套選班但排除本欄 grade=2；0 人值仍回傳，limit=1／cursor 不截斷', async () => {
    const first = await query({ enrollmentKey: MATH, limit: '1' });
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).not.toBeNull();
    const opts = await query({ options: 'true', enrollmentKey: MATH, grade: '2', limit: '1', cursor: first.body.nextCursor });
    expect(counts(opts.body, 'grade')).toEqual({ '1': 2, '2': 1, '3': 0, '4': 0, '5': 0, '~blank': 0 });
    expect(opts.body.noCourseTotal).toBe(1);
  });

  it('每個 grade count 等於把本欄替換為單一該值後的名單人數，不做同欄 OR 累加', async () => {
    const opts = await query({ options: 'true', enrollmentKey: MATH, grade: '2' });
    for (const [value, expected] of [['1', 2], ['2', 1], ['3', 0]] as const) {
      const selected = await query({ enrollmentKey: MATH, grade: value });
      expect(selected.body.totalStudents).toBe(expected);
      expect(counts(opts.body, 'grade')[value]).toBe(expected);
    }
  });

  it('跨欄非法組合（hasIssues=false＋issueCode、tierMismatch↔tierComparison）候選回值但 count=0；合法組合照常計數', async () => {
    const opts = await query({ options: 'true', hasIssues: 'false' }, issueRunId);
    expect(opts.status).toBe(200);
    expect(counts(opts.body, 'issueCode')).toEqual({ STAFF_FAMILY_NO_DISCOUNT: 0, '~blank': 0 });
    expect((await query({ hasIssues: 'false', issueCode: 'STAFF_FAMILY_NO_DISCOUNT' }, issueRunId)).status).toBe(400);
    expect((await query({ hasIssues: 'true', issueCode: 'STAFF_FAMILY_NO_DISCOUNT' }, issueRunId)).body.totalStudents).toBe(1);
    // 輔導班範圍：一年級C僅輔導一A→match；二年級B輔導無宣告→mismatch，數學一A重複報名→not_applicable。
    const comparisons = await query({ options: 'true', enrollmentKey: CARE }, runId);
    expect(counts(comparisons.body, 'tierMismatch')).toEqual({ true: 1, false: 1 });
    const mismatchOnly = await query({ options: 'true', tierMismatch: 'true' }, runId);
    expect(counts(mismatchOnly.body, 'tierComparison')).toEqual({ '~blank': 0, mismatch: 1, not_applicable: 1, match: 0, unavailable: 0 });
    expect((await query({ tierMismatch: 'true', tierComparison: 'match' }, runId)).status).toBe(400);
  });

  it('班級欄排除自欄、保留 grade=2：同生同班兩個 token 仍只算一人', async () => {
    const opts = await query({ options: 'true', enrollmentKey: MATH, grade: '2' });
    expect(counts(opts.body, 'enrollmentKey')).toMatchObject({ [MATH]: 1, [CARE]: 1, '~blank': 0, '~empty': 0 });
    const both = await query({ enrollmentKey: [MATH, CARE], grade: '2' });
    expect(both.body.items.map((s: any) => s.personCode)).toEqual(['B']);
    expect(both.body.totalStudents).toBe(1);
  });

  it('搜尋與 hasIssues 均套其他欄：合成A 是 math 且無 issue；G 的南校只在搜尋 G 時計一人', async () => {
    const opts = await query({ options: 'true', enrollmentKey: MATH, q: '合成A' });
    expect(counts(opts.body, 'grade')).toMatchObject({ '1': 1, '2': 0 });
    expect(counts(opts.body, 'hasIssues').false).toBe(1);
    expect(counts(opts.body, 'hasIssues').true ?? 0).toBe(0);
    const selected = await query({ enrollmentKey: MATH, q: '合成A', hasIssues: 'false' });
    expect(selected.body.items.map((s: any) => s.personCode)).toEqual(['A']);
    const branch = await query({ options: 'true', q: '合成G' });
    expect(counts(branch.body, 'branch')).toEqual({ '北校': 1, '南校': 1, '~blank': 0 });
  });

  it('~blank／~empty／~none 是不同範圍；自欄 ~none 不影響自身候選數', async () => {
    const blank = await query({ options: 'true', enrollmentKey: '~blank' });
    expect(counts(blank.body, 'grade')['~blank']).toBe(1);
    expect(counts(blank.body, 'grade')['1']).toBe(0);
    const empty = await query({ options: 'true', enrollmentKey: '~empty' });
    expect(counts(empty.body, 'grade')['4']).toBe(1);
    const none = await query({ options: 'true', enrollmentKey: '~none' });
    expect(Object.values(counts(none.body, 'grade')).every((n) => n === 0)).toBe(true);
    expect(counts(none.body, 'enrollmentKey')[MATH]).toBe(3);
    expect(none.body.noCourseTotal).toBe(1);
  });

  it('特殊折扣跨欄篩選：只有 B；自己的選項排除自身但不影響其他欄', async () => {
    const opts = await query({ options: 'true', enrollmentKey: MATH, specialDiscount: 'true' });
    expect(counts(opts.body, 'grade')).toMatchObject({ '1': 0, '2': 1 });
    expect(counts(opts.body, 'specialDiscount')).toEqual({ false: 2, true: 1 });
  });

  it('本班適用折扣排除自身保留原選班 context；未選班、未配置班三分支仍可區分', async () => {
    const opts = await query({ options: 'true', enrollmentKey: MATH, applicableDiscountBps: '8500' });
    expect(opts.body.applicableRateContext).toMatchObject({ classKey: MATH, status: 'configured' });
    expect(counts(opts.body, 'applicableDiscountBps')).toEqual({ '8500': 1, '10000': 2 });
    const noClass = await query({ options: 'true' });
    expect(noClass.body.applicableRateContext).toMatchObject({ classKey: null, status: 'requires_class' });
    const unconfigured = await query({ options: 'true', enrollmentKey: '合成未知班' });
    expect(unconfigured.body.applicableRateContext).toMatchObject({ classKey: '合成未知班', status: 'not_configured' });
    expect(unconfigured.body.options.applicableDiscountBps).toEqual([]);
  });
});
