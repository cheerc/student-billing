import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { activateImport } from '@/application/activate-import';
import { parseClassTokens, type StudentSnapshot } from '@/domain/students';
import { queryImportStudents } from '@/application/roster-query';
import { readStudentQuery } from '@/contracts/student-query';
import { GET as runGET } from '@/app/api/v1/runs/[runId]/students/route';

/** D65 B3／UX127／UX128：合成名冊 → 真實 activate → 真實 route；expected 依合成輸入手算。 */
const CARE = '國小輔導-一A';
const MATH = '國小數學-一A';
const IMP = 'imp_b3_sort';
const code = (i: number) => `SORT_${String(i).padStart(3, '0')}`;

function s(i: number, name: string, grade: number | null, classes: string): StudentSnapshot {
  return {
    personCode: code(i), name, branch: '北校', grade, gradeRaw: grade === null ? '未知' : `${grade}年級`,
    gradeStatus: grade === null ? 'unavailable' : 'valid', contact: null, schoolInfo: null,
    tagsRaw: '', tags: [], notesRaw: '', enrollments: parseClassTokens(classes), sourceRow: i + 1,
  };
}

// 姓名碼點序：'B'(42) < 'Z'(5A) < '_'(5F) < 'a'(61) < 'ab' < 'b'(62) < '一'(U+4E00) < '中'(U+4E2D)
const ROSTER: StudentSnapshot[] = [
  s(1, 'b', 3, `${CARE}[團]`),
  s(2, 'B', null, `${CARE}[團]`),
  s(3, '中', 10, `${CARE}[團]`),
  s(4, 'a', null, `${MATH}[團]`),
  s(5, '一', 2, `${CARE}[團]`),
  s(6, 'Z', null, `${CARE}[團]`),
  s(7, 'ab', 3, `${MATH}[團]`),
  s(8, '_', 10, `${CARE}[團]`),
];
const ALL_BY_CODE = [1, 2, 3, 4, 5, 6, 7, 8].map(code);
const BY_NAME = [2, 6, 8, 4, 7, 1, 5, 3].map(code);
// grade 數值升冪（2 < 3 < 10），null 最後；同值依 personCode
const BY_GRADE = [5, 1, 7, 3, 8, 2, 4, 6].map(code);
const BY_GRADE_DESC = [3, 8, 1, 7, 5, 2, 4, 6].map(code);

async function run(runId: string, pairs: Array<[string, string]> = []) {
  const response = await runGET(new NextRequest(`http://127.0.0.1:3100/api/v1/runs/${runId}/students?${new URLSearchParams(pairs)}`), { params: Promise.resolve({ runId }) });
  return { status: response.status, body: await response.json() };
}
async function preview(pairs: Array<[string, string]> = []) {
  try { return { status: 200, body: queryImportStudents(getDatabase(), IMP, readStudentQuery(new URLSearchParams(pairs))) as any }; }
  catch (e: any) { return { status: e.statusCode ?? 500, body: { error: e.message } as any }; }
}
const codes = (b: any): string[] => b.items.map((x: any) => x.personCode);

async function pageAll(fetchPage: (pairs: Array<[string, string]>) => Promise<{ status: number; body: any }>, base: Array<[string, string]>, limit: number) {
  const pages: string[][] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard++) {
    const pairs: Array<[string, string]> = [...base, ['limit', String(limit)]];
    if (cursor) pairs.push(['cursor', cursor]);
    const r = await fetchPage(pairs);
    expect(r.status).toBe(200);
    pages.push(codes(r.body));
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  return pages;
}

describe('D65 B3 學生總表 server 排序與 keyset cursor', () => {
  let dir: string;
  let runId: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-b3-sort-'));
    process.env.DATABASE_PATH = path.join(dir, 'test.sqlite');
    if (global.__sqlite_db__) global.__sqlite_db__.close();
    global.__sqlite_db__ = undefined;
    saveImportBatch(getDatabase(), {
      id: IMP, fileName: 'synthetic.xlsx', fileHash: 'h-b3', contentHash: 'c-b3', sheetName: 'Sheet1', headerMap: {},
      parserVersion: '1.0.0', scopeNote: '全合成 B3', rowCount: ROSTER.length, status: 'ready', createdAt: '2026-09-30T00:00:00.000Z',
    }, ROSTER);
    runId = activateImport(getDatabase(), { importId: IMP, expectedRevision: 0, idempotencyKey: 'activate-b3' }).runId;
  });
  afterEach(() => {
    global.__sqlite_db__?.close();
    global.__sqlite_db__ = undefined;
    delete process.env.DATABASE_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('UX128：未帶 sort 依 personCode 升冪，含 cursor 分頁（run 與 preview）', async () => {
    expect(codes((await run(runId)).body)).toEqual(ALL_BY_CODE);
    expect((await pageAll((p) => run(runId, p), [], 3)).flat()).toEqual(ALL_BY_CODE);
    expect(codes((await preview()).body)).toEqual(ALL_BY_CODE);
    expect((await pageAll(preview, [], 3)).flat()).toEqual(ALL_BY_CODE);
  });

  it('UX127(c)：name 依 UTF-8 碼點序；grade 依數值、null 最後（兩方向）', async () => {
    expect(codes((await run(runId, [['sort', 'name']])).body)).toEqual(BY_NAME);
    expect(codes((await run(runId, [['sort', '-name']])).body)).toEqual([...BY_NAME].reverse());
    expect(codes((await run(runId, [['sort', 'grade']])).body)).toEqual(BY_GRADE);
    // 降冪：數值由大到小，null 仍在最後，同值仍依 personCode 升冪
    expect(codes((await run(runId, [['sort', '-grade']])).body)).toEqual(BY_GRADE_DESC);
  });

  it('UX127(b)：grade limit=2 逐頁取完，頁界落在 tie 群內與 null 群內，無重複無遺漏', async () => {
    const pages = await pageAll((p) => run(runId, p), [['sort', 'grade']], 2);
    expect(pages).toEqual([[code(5), code(1)], [code(7), code(3)], [code(8), code(2)], [code(4), code(6)]]);
    // 頁界 code(1)|code(7) 同為 grade 3（tie 群內）；code(2)|code(4) 同為 null（null 群內）
    expect(pages.flat()).toEqual(BY_GRADE);
  });

  it('UX127(a)：anqinDays 降冪 limit=2 逐頁取完＝一次取全量；null 最後、同值依 personCode', async () => {
    const rows = getDatabase().prepare('SELECT person_code, anqin_days FROM student_calculations WHERE run_id = ?').all(runId) as Array<{ person_code: string; anqin_days: number | null }>;
    expect(rows.filter((r) => r.anqin_days === null).length).toBeGreaterThanOrEqual(2);
    const byVal = new Map<number, number>();
    for (const r of rows) if (r.anqin_days !== null) byVal.set(r.anqin_days, (byVal.get(r.anqin_days) ?? 0) + 1);
    expect(Math.max(...byVal.values())).toBeGreaterThanOrEqual(3);
    const expected = [...rows].sort((a, b) => {
      if ((a.anqin_days === null) !== (b.anqin_days === null)) return a.anqin_days === null ? 1 : -1;
      if (a.anqin_days !== b.anqin_days) return (b.anqin_days as number) - (a.anqin_days as number);
      return a.person_code < b.person_code ? -1 : 1;
    }).map((r) => r.person_code);
    const pages = await pageAll((p) => run(runId, p), [['sort', '-anqinDays']], 2);
    expect(pages.flat()).toEqual(expected);
    expect((await run(runId, [['sort', '-anqinDays'], ['limit', '200']])).body.items.map((x: any) => x.personCode)).toEqual(expected);
  });

  it('UX127(d)：白名單外 sort 回 400 並指名 sort', async () => {
    for (const bad of ['bogus', 'enrollment', '-enrollment', '']) {
      if (bad === '') continue;
      const r = await run(runId, [['sort', bad]]);
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toContain('sort');
    }
    expect((await run(runId, [['sort', 'a'], ['sort', 'b']])).status).toBe(400);
  });

  it('UX127(e)：改 sort 沿用舊 cursor 回 400；v1 舊格式 cursor 回 400', async () => {
    const first = await run(runId, [['sort', 'anqinDays'], ['limit', '2']]);
    expect(first.body.nextCursor).toBeTruthy();
    expect((await run(runId, [['sort', '-anqinDays'], ['cursor', first.body.nextCursor]])).status).toBe(400);
    expect((await run(runId, [['cursor', first.body.nextCursor]])).status).toBe(400);
    const v1 = Buffer.from(JSON.stringify({ version: 1, identity: 'x', after: code(1) })).toString('base64');
    expect((await run(runId, [['cursor', v1]])).status).toBe(400);
  });

  it('UX127(f)：preview 僅接受 name／grade；anqinDays 回 400 指名 sort', async () => {
    expect(codes((await preview([['sort', 'name']])).body)).toEqual(BY_NAME);
    expect(codes((await preview([['sort', '-grade']])).body)).toEqual(BY_GRADE_DESC);
    expect((await pageAll(preview, [['sort', 'grade']], 2)).flat()).toEqual(BY_GRADE);
    const bad = await preview([['sort', 'anqinDays']]);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('sort');
  });
});
