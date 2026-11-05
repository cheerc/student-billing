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

  it('UX127(a)：anqinDays 降冪 limit=2 逐頁取完，頁界落在同值群內與 null 群內；null 最後、同值依 personCode', async () => {
    // 直接設定合成的持久化計算值（查詢層測試，不依賴課表計算）：
    // 5 天＝S2,S8；3 天＝S1,S3,S5；1 天＝S6；null＝S4,S7
    const set = getDatabase().prepare('UPDATE student_calculations SET anqin_days = ? WHERE run_id = ? AND person_code = ?');
    const values: Record<number, number | null> = { 1: 3, 2: 5, 3: 3, 4: null, 5: 3, 6: 1, 7: null, 8: 5 };
    for (const [i, v] of Object.entries(values)) set.run(v, runId, code(Number(i)));
    const desc = [2, 8, 1, 3, 5, 6, 4, 7].map(code);
    const asc = [6, 1, 3, 5, 2, 8, 4, 7].map(code);
    const pages = await pageAll((p) => run(runId, p), [['sort', '-anqinDays']], 2);
    expect(pages).toEqual([[code(2), code(8)], [code(1), code(3)], [code(5), code(6)], [code(4), code(7)]]);
    expect(pages.flat()).toEqual(desc);
    expect((await pageAll((p) => run(runId, p), [['sort', 'anqinDays']], 3)).flat()).toEqual(asc);
    expect(codes((await run(runId, [['sort', '-anqinDays'], ['limit', '200']])).body)).toEqual(desc);
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

  it('N1：形狀與 sort 不符的偽造 v2 cursor 一律 400 指名 cursor（不得 500）', async () => {
    const real = (await run(runId, [['sort', 'anqinDays'], ['limit', '2']])).body.nextCursor as string;
    const body = JSON.parse(Buffer.from(real, 'base64').toString('utf8'));
    const forge = (patch: Record<string, unknown>, drop: string[] = []) => {
      const next: Record<string, unknown> = { ...body, ...patch };
      for (const k of drop) delete next[k];
      return Buffer.from(JSON.stringify(next)).toString('base64');
    };
    const cases: Array<[string, Array<[string, string]>, string]> = [
      ['sort 下缺 v/n', [['sort', 'anqinDays']], forge({}, ['v', 'n'])],
      ['數值欄帶字串 v', [['sort', 'anqinDays']], forge({ v: 'x' }, ['n'])],
      ['sort 欄帶布林 v', [['sort', 'anqinDays']], forge({ v: true }, ['n'])],
      ['未排序卻帶 v', [], forge({ v: 1 })],
    ];
    for (const [label, pairs, cursor] of cases) {
      const r = await run(runId, [...pairs, ['cursor', cursor]]);
      // identity 綁 sort：未排序案例的 identity 不同，同樣必須 400 而非 500
      expect(r.status, label).toBe(400);
      expect(JSON.stringify(r.body), label).toContain('cursor');
    }
    // 文字欄（name）帶數值 v、數值欄（grade）帶字串 v：以各自 sort 的真實 identity 偽造
    const nameCur = JSON.parse(Buffer.from((await run(runId, [['sort', 'name'], ['limit', '2']])).body.nextCursor, 'base64').toString('utf8'));
    const gradeCur = JSON.parse(Buffer.from((await run(runId, [['sort', 'grade'], ['limit', '2']])).body.nextCursor, 'base64').toString('utf8'));
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
    expect((await run(runId, [['sort', 'name'], ['cursor', enc({ ...nameCur, v: 7 })]])).status).toBe(400);
    expect((await run(runId, [['sort', 'grade'], ['cursor', enc({ ...gradeCur, v: 'abc' })]])).status).toBe(400);
    const pCur = JSON.parse(Buffer.from((await preview([['sort', 'name'], ['limit', '2']])).body.nextCursor, 'base64').toString('utf8'));
    expect((await preview([['sort', 'name'], ['cursor', enc({ ...pCur, v: 7 })]])).status).toBe(400);
    const missing = { ...pCur }; delete missing.v; delete missing.n;
    const pr = await preview([['sort', 'name'], ['cursor', enc(missing)]]);
    expect(pr.status).toBe(400);
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
