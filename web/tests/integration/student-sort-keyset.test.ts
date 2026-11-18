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
// D66（UX131）學生總表 `sort=grade`：數值年級 → 文字年級（grade_raw『未知』）→ 空白，且降冪反轉 value：文字在前、數值大→小。
// 本名冊 null 年級者 grade_raw 皆為『未知』（文字，不是空白）：升冪 2 < 3 < 10 < 未知；降冪 未知（S2,S4,S6）→ 10 → 3 → 2，同值依 personCode 升冪。
const RUN_BY_GRADE = BY_GRADE;
const RUN_BY_GRADE_DESC = [2, 4, 6, 3, 8, 1, 7, 5].map(code);

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

  it('UX131(b)：name 依筆畫序（不是碼點序）、兩方向；以總筆畫數相異的合成姓名手算', async () => {
    // 乙(1) < 丁一(3) < 王一(5) < 吳一(8) < 林一(9) < 黃一(13) < 蔡一(15) < 龜(16)。碼點序為 丁一(U+4E01) 乙(U+4E59) 吳一 林一 王一 蔡一 黃一 龜（丁 < 乙 與筆畫序相反）。
    const set = getDatabase().prepare('UPDATE student_calculations SET name = ? WHERE run_id = ? AND person_code = ?');
    const names: Record<number, string> = { 1: '蔡一', 2: '黃一', 3: '林一', 4: '王一', 5: '吳一', 6: '丁一', 7: '乙', 8: '龜' };
    for (const [i, n] of Object.entries(names)) set.run(n, runId, code(Number(i)));
    const asc = [7, 6, 4, 5, 3, 2, 1, 8].map(code);
    expect(codes((await run(runId, [['sort', 'name']])).body)).toEqual(asc);
    expect(codes((await run(runId, [['sort', 'name']])).body)).not.toEqual([6, 7, 5, 3, 4, 1, 2, 8].map(code));
    expect(codes((await run(runId, [['sort', '-name']])).body)).toEqual([8, 1, 2, 3, 5, 4, 6, 7].map(code));
    expect((await pageAll((p) => run(runId, p), [['sort', 'name']], 3)).flat()).toEqual(asc);
  });

  it('UX131(a)：grade 依數值→文字（grade_raw）→空白；降冪文字在前、數值大→小（兩方向）', async () => {
    expect(codes((await run(runId, [['sort', 'grade']])).body)).toEqual(RUN_BY_GRADE);
    expect(codes((await run(runId, [['sort', '-grade']])).body)).toEqual(RUN_BY_GRADE_DESC);
  });

  it('UX127(b)：grade limit=2 逐頁取完，頁界落在 tie 群內與 null 群內，無重複無遺漏', async () => {
    const pages = await pageAll((p) => run(runId, p), [['sort', 'grade']], 2);
    expect(pages).toEqual([[code(5), code(1)], [code(7), code(3)], [code(8), code(2)], [code(4), code(6)]]);
    // 頁界 code(1)|code(7) 同為 grade 3（tie 群內）；code(2)|code(4) 同為文字年級『未知』（文字群內，D66 起 null 年級有 grade_raw 者不再是空白）
    expect(pages.flat()).toEqual(RUN_BY_GRADE);
  });

  it('UX127(a)：anqinDays 降冪 limit=2 逐頁取完，頁界落在同值群內與 null 群內；null 最後、同值依 personCode', async () => {
    // 直接設定合成的持久化計算值（查詢層測試，不依賴課表計算）：
    // 5 天＝S2,S8；3 天＝S1,S3,S5；1 天＝S6；null＝S4,S7
    const set = getDatabase().prepare('UPDATE student_calculations SET anqin_days = ? WHERE run_id = ? AND person_code = ?');
    const values: Record<number, number | null> = { 1: 3, 2: 5, 3: 3, 4: null, 5: 3, 6: 1, 7: null, 8: 5 };
    // D66：儲存格＝底層值＋顯示文字；顯示文字（anqin_display）為空者視為空白，故同步寫入整數天數的顯示文字。
    const setDisplay = getDatabase().prepare('UPDATE student_calculations SET anqin_display = ? WHERE run_id = ? AND person_code = ?');
    for (const [i, v] of Object.entries(values)) { set.run(v, runId, code(Number(i))); setDisplay.run(v === null ? null : String(v), runId, code(Number(i))); }
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

  it('UX127(e)：改 sort 沿用舊 cursor 回 400；v1 與 v2 舊格式 cursor 回 400', async () => {
    const first = await run(runId, [['sort', 'anqinDays'], ['limit', '2']]);
    expect(first.body.nextCursor).toBeTruthy();
    expect((await run(runId, [['sort', '-anqinDays'], ['cursor', first.body.nextCursor]])).status).toBe(400);
    expect((await run(runId, [['cursor', first.body.nextCursor]])).status).toBe(400);
    const v1 = Buffer.from(JSON.stringify({ version: 1, identity: 'x', after: code(1) })).toString('base64');
    expect((await run(runId, [['cursor', v1]])).status).toBe(400);
    // D66：runs 端點只認 v3；以 v3 cursor 改版為 v2（identity 不變）一律 400
    const real = JSON.parse(Buffer.from(first.body.nextCursor, 'base64').toString('utf8'));
    const v2 = Buffer.from(JSON.stringify({ ...real, version: 2 })).toString('base64');
    expect((await run(runId, [['sort', 'anqinDays'], ['cursor', v2]])).status).toBe(400);
  });

  it('N1：形狀不符的偽造 cursor 一律 400 指名 cursor（runs 為 v3、preview 仍為 v2；不得 500）', async () => {
    // 合成安親天數（含顯示文字）使第 1 頁最後一列為非空白儲存格：cursor 帶 v＋t（空白列的 cursor 則帶 n）。
    const setDays = getDatabase().prepare('UPDATE student_calculations SET anqin_days = ?, anqin_display = ? WHERE run_id = ? AND person_code = ?');
    [1, 2, 3, 4, 5, 6, 7, 8].forEach((i) => setDays.run(i, String(i), runId, code(i)));
    const real = (await run(runId, [['sort', 'anqinDays'], ['limit', '2']])).body.nextCursor as string;
    const body = JSON.parse(Buffer.from(real, 'base64').toString('utf8'));
    expect(body).toMatchObject({ version: 3, p: code(2), v: 2, t: '2' });
    const forge = (patch: Record<string, unknown>, drop: string[] = []) => {
      const next: Record<string, unknown> = { ...body, ...patch };
      for (const k of drop) delete next[k];
      return Buffer.from(JSON.stringify(next)).toString('base64');
    };
    // D66 cursor v3：runs 端點的 `v` 可為數值或字串（底層值），但必須同時帶 `t`，且 `n` 與 `v`／`t` 互斥；舊 v2 一律 400。
    const cases: Array<[string, Array<[string, string]>, string]> = [
      ['sort 下缺 v/n/t', [['sort', 'anqinDays']], forge({}, ['v', 'n', 't'])],
      ['sort 下缺 t', [['sort', 'anqinDays']], forge({}, ['n', 't'])],
      ['sort 欄帶布林 v', [['sort', 'anqinDays']], forge({ v: true }, ['n'])],
      ['n 與 v 並存', [['sort', 'anqinDays']], forge({ n: true })],
      ['未排序卻帶 v', [], forge({ v: 1 })],
      ['版本 2', [['sort', 'anqinDays']], forge({ version: 2 })],
    ];
    for (const [label, pairs, cursor] of cases) {
      const r = await run(runId, [...pairs, ['cursor', cursor]]);
      // identity 綁 sort：未排序案例的 identity 不同，同樣必須 400 而非 500
      expect(r.status, label).toBe(400);
      expect(JSON.stringify(r.body), label).toContain('cursor');
    }
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
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
