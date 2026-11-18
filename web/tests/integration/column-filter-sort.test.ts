import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { activateImport } from '@/application/activate-import';
import { parseClassTokens, type StudentSnapshot } from '@/domain/students';
import { GET as runGET } from '@/app/api/v1/runs/[runId]/students/route';

/**
 * D66 P3a／UX130（03 §5.1 R1–R10、04 UX130）：合成名冊 → 真實 activate → 真實 route GET。
 * expected 依 04 UX130 的 G13 手算表與 03 R7 寫死，不以待測函式輸出產生。
 */

function snap(code: string, grade: number | null, gradeRaw: string | null, classes: string, name = `學生${code}`): StudentSnapshot {
  return {
    personCode: code, name, branch: '北校', grade, gradeRaw,
    gradeStatus: grade === null ? 'unavailable' : 'valid', contact: null, schoolInfo: null,
    tagsRaw: '', tags: [], notesRaw: '', enrollments: classes ? parseClassTokens(classes) : [], sourceRow: 2,
  };
}

// 04 UX130 合成 run G13（P07 不存在）。P05 同班報名兩個 token（班A、班A[團]）——驗 count 以 personCode 去重。
const G13: StudentSnapshot[] = [
  snap('P01', 1, '一年級', '班A'),
  snap('P02', 1, '1', '班B'),
  snap('P03', 3, '小三', '班B'),
  snap('P04', 3, '三年級', '班B'),
  snap('P05', null, '中班', '班A\n班A[團]'),
  snap('P06', null, '小班', '班B'),
  snap('P08', null, '國一', '班B'),
  snap('P09', null, '未知', '班B'),
  snap('P10', null, '7', '班B'),
  snap('P11', null, null, '班A'),
  snap('P12', null, null, ''),
  snap('P13', null, '國中', '班B'),
];

let dir: string;
let seq = 0;

function setup(roster: StudentSnapshot[]): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-d66-p3a-'));
  process.env.DATABASE_PATH = path.join(dir, 'test.sqlite');
  if (global.__sqlite_db__) global.__sqlite_db__.close();
  global.__sqlite_db__ = undefined;
  const importId = `imp_d66_p3a_${++seq}`;
  saveImportBatch(getDatabase(), {
    id: importId, fileName: 'synthetic.xlsx', fileHash: `h-${importId}`, contentHash: `c-${importId}`, sheetName: 'Sheet1', headerMap: {},
    parserVersion: '1.0.0', scopeNote: '全合成 D66 P3a', rowCount: roster.length, status: 'ready', createdAt: '2026-11-18T00:00:00.000Z',
  }, roster);
  return activateImport(getDatabase(), { importId, expectedRevision: 0, idempotencyKey: `activate-${importId}` }).runId;
}

function teardown() {
  global.__sqlite_db__?.close();
  global.__sqlite_db__ = undefined;
  delete process.env.DATABASE_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
}

async function get(runId: string, pairs: Array<[string, string]> = []) {
  const response = await runGET(new NextRequest(`http://127.0.0.1:3100/api/v1/runs/${runId}/students?${new URLSearchParams(pairs)}`), { params: Promise.resolve({ runId }) });
  return { status: response.status, body: await response.json() };
}
const codes = (b: any): string[] => b.items.map((x: any) => x.personCode);
const asMap = (list: Array<{ value: string; count: number }>) => Object.fromEntries(list.map((o) => [o.value, o.count]));

describe('UX130 學生總表 col.* 篩選、columnOptions 與 Agent 語意參數相容（G13）', () => {
  let runId: string;
  beforeEach(() => { runId = setup(G13); });
  afterEach(teardown);

  it('(a) options=true：columnOptions.grade 依序 1年級:2、3年級:2、7:1、小班:1、中班:1、未知:1、國一:1、國中:1、~blank:2；既有 options.grade 不變', async () => {
    const r = await get(runId, [['options', 'true']]);
    expect(r.status).toBe(200);
    expect(r.body.columnOptions.grade).toEqual([
      { value: '1年級', count: 2 }, { value: '3年級', count: 2 }, { value: '7', count: 1 }, { value: '小班', count: 1 },
      { value: '中班', count: 1 }, { value: '未知', count: 1 }, { value: '國一', count: 1 }, { value: '國中', count: 1 },
      { value: '~blank', count: 2 },
    ]);
    expect(asMap(r.body.options.grade)).toEqual({ '1': 2, '3': 2, '~blank': 8 });
  });

  it('(a+) columnOptions.enrollment 以 personCode 去重：P05 同班兩個 token 仍只計 1 人', async () => {
    const r = await get(runId, [['options', 'true']]);
    // 班A：P01、P05（兩個 token）、P11＝3 人；班B：P02,P03,P04,P06,P08,P09,P10,P13＝8 人；無報名 P12＝1 人（~blank）
    expect(r.body.columnOptions.enrollment).toEqual([
      { value: '班A', count: 3 }, { value: '班B', count: 8 }, { value: '~blank', count: 1 },
    ]);
  });

  it('(b) col.grade 以顯示文字篩選：中班／7／3年級／~blank／多值 OR／與語意 grade AND', async () => {
    const cases: Array<[Array<[string, string]>, string[]]> = [
      [[['col.grade', '中班']], ['P05']],
      [[['col.grade', '7']], ['P10']],
      [[['col.grade', '3年級']], ['P03', 'P04']],
      [[['col.grade', '~blank']], ['P11', 'P12']],
      [[['col.grade', '1年級'], ['col.grade', '小班']], ['P01', 'P02', 'P06']],
      [[['col.grade', '中班'], ['grade', '3']], []],
    ];
    for (const [pairs, expected] of cases) {
      const r = await get(runId, [...pairs, ['limit', '200']]);
      expect(r.status, JSON.stringify(pairs)).toBe(200);
      expect(codes(r.body), JSON.stringify(pairs)).toEqual(expected);
      expect(r.body.totalStudents, JSON.stringify(pairs)).toBe(expected.length);
      expect(r.body.stats.totalStudents, JSON.stringify(pairs)).toBe(expected.length);
    }
  });

  it('(c) 語意參數逐位元不變：grade=~blank、grade=3', async () => {
    expect(codes((await get(runId, [['grade', '~blank'], ['limit', '200']])).body)).toEqual(['P05', 'P06', 'P08', 'P09', 'P10', 'P11', 'P12', 'P13']);
    expect(codes((await get(runId, [['grade', '3'], ['limit', '200']])).body)).toEqual(['P03', 'P04']);
  });

  it('(d) 400 並指名參數：未知 columnKey、不可篩選欄、空字串、~empty、~none 並存、未恰選一班帶 col.applicableDiscount', async () => {
    const cases: Array<[Array<[string, string]>, string]> = [
      [[['col.bogus', 'x']], 'col.bogus'],
      [[['col.name', 'x']], 'col.name'],
      [[['col.subjectCount', '1']], 'col.subjectCount'],
      [[['col.grade', '']], 'col.grade'],
      [[['col.grade', '~empty']], 'col.grade'],
      [[['col.grade', '~none'], ['col.grade', '1年級']], 'col.grade'],
      [[['col.applicableDiscount', '95折']], 'col.applicableDiscount'],
      [[['col.enrollment', '班A'], ['col.enrollment', '班B'], ['col.applicableDiscount', '95折']], 'col.applicableDiscount'],
      [[['col.enrollment', '~blank'], ['col.applicableDiscount', '95折']], 'col.applicableDiscount'],
      [[['enrollmentKey', '班A'], ['enrollmentKey', '班B'], ['col.applicableDiscount', '95折']], 'col.applicableDiscount'],
      // R7 恰選一班：兩方並存須各自恰選同一班，不以任一方靜默優先
      [[['col.enrollment', '班A'], ['enrollmentKey', '班B'], ['col.applicableDiscount', '95折']], 'col.applicableDiscount'],
      [[['col.enrollment', '班A'], ['enrollmentKey', '班A'], ['enrollmentKey', '班B'], ['col.applicableDiscount', '95折']], 'col.applicableDiscount'],
      [[['col.enrollment', '班A'], ['col.enrollment', '班B'], ['enrollmentKey', '班A'], ['col.applicableDiscount', '95折']], 'col.applicableDiscount'],
    ];
    for (const [pairs, param] of cases) {
      for (const options of [false, true]) {
        const r = await get(runId, options ? [...pairs, ['options', 'true']] : pairs);
        expect(r.status, JSON.stringify(pairs)).toBe(400);
        expect(r.body.error, JSON.stringify(pairs)).toContain(param);
      }
    }
  });

  it('(d+) 恰選一班（單方或兩方同一班）時 col.applicableDiscount 可用：未配置班＝「未設定」', async () => {
    // G13 的班A 沒有課表／類別快照＝未配置，本班適用折扣顯示「未設定」（03 R6）
    for (const pairs of [
      [['col.enrollment', '班A'], ['col.applicableDiscount', '未設定']],
      [['enrollmentKey', '班A'], ['col.applicableDiscount', '未設定']],
      [['col.enrollment', '班A'], ['enrollmentKey', '班A'], ['col.applicableDiscount', '未設定']],
    ] as Array<Array<[string, string]>>) {
      const r = await get(runId, [...pairs, ['limit', '200']]);
      expect(r.status, JSON.stringify(pairs)).toBe(200);
      expect(codes(r.body), JSON.stringify(pairs)).toEqual(['P01', 'P05', 'P11']);
    }
    // 不在值域的顯示文字匹配 0 人、不回 400
    const none = await get(runId, [['col.enrollment', '班A'], ['col.applicableDiscount', '9折']]);
    expect(none.status).toBe(200);
    expect(codes(none.body)).toEqual([]);
  });

  it('(d++) ~none 為空集合：0 筆且各項 stats 為 0（classScopeTotal 亦 0）', async () => {
    const r = await get(runId, [['col.grade', '~none']]);
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect(r.body.stats).toMatchObject({ totalStudents: 0, mismatchCount: 0, issuesCount: 0, classScopeTotal: 0, filteredNoCourseCount: 0 });
  });

  it('(e) col.enrollment=班A：columnOptions.grade 計數 1年級:1、中班:1、~blank:1，其餘值仍回傳 count=0（D46）；stats.classScopeTotal=3；legacy options 另被 col.* 限縮', async () => {
    const opts = await get(runId, [['col.enrollment', '班A'], ['options', 'true']]);
    expect(opts.status).toBe(200);
    expect(opts.body.columnOptions.grade).toEqual([
      { value: '1年級', count: 1 }, { value: '3年級', count: 0 }, { value: '7', count: 0 }, { value: '小班', count: 0 },
      { value: '中班', count: 1 }, { value: '未知', count: 0 }, { value: '國一', count: 0 }, { value: '國中', count: 0 },
      { value: '~blank', count: 1 },
    ]);
    // 本欄（enrollment）條件排除：班A、班B、無報名皆有原值計數
    expect(opts.body.columnOptions.enrollment).toEqual([
      { value: '班A', count: 3 }, { value: '班B', count: 8 }, { value: '~blank', count: 1 },
    ]);
    // 既有 options 在帶 col.* 時另限縮到通過全部 col.* 的人（班A＝P01,P05,P11）；值宇宙不變
    expect(asMap(opts.body.options.grade)).toEqual({ '1': 1, '3': 0, '~blank': 2 });
    const list = await get(runId, [['col.enrollment', '班A'], ['limit', '200']]);
    expect(codes(list.body)).toEqual(['P01', 'P05', 'P11']);
    expect(list.body.stats.classScopeTotal).toBe(3);
    expect(list.body.stats.totalStudents).toBe(3);
  });

  it('(e+) 兩個 col.* 欄互為條件（跨欄 AND），columnOptions 排除本欄：班A＋col.grade=中班', async () => {
    const opts = await get(runId, [['col.enrollment', '班A'], ['col.grade', '中班'], ['options', 'true']]);
    // grade 欄排除 col.grade，只剩 col.enrollment=班A → 同 (e)
    expect(asMap(opts.body.columnOptions.grade)).toEqual({ '1年級': 1, '3年級': 0, '7': 0, '小班': 0, '中班': 1, '未知': 0, '國一': 0, '國中': 0, '~blank': 1 });
    // enrollment 欄排除 col.enrollment，只剩 col.grade=中班（P05：班A）
    expect(asMap(opts.body.columnOptions.enrollment)).toEqual({ 班A: 1, 班B: 0, '~blank': 0 });
    const list = await get(runId, [['col.enrollment', '班A'], ['col.grade', '中班']]);
    expect(codes(list.body)).toEqual(['P05']);
    expect(list.body.stats).toMatchObject({ totalStudents: 1, classScopeTotal: 3 });
  });

  it('col.* 納入 cursor identity：換 col.* 沿用舊 cursor 回 400 指名 cursor；同條件逐頁取完＝一次取全', async () => {
    const base: Array<[string, string]> = [['col.grade', '1年級'], ['col.grade', '3年級'], ['col.grade', '~blank']];
    const first = await get(runId, [...base, ['limit', '2']]);
    expect(first.status).toBe(200);
    expect(codes(first.body)).toEqual(['P01', 'P02']);
    expect(first.body.nextCursor).toBeTruthy();
    const other = await get(runId, [['col.grade', '1年級'], ['cursor', first.body.nextCursor]]);
    expect(other.status).toBe(400);
    expect(other.body.error).toContain('cursor');
    const seen: string[] = [...codes(first.body)];
    let cursor: string | null = first.body.nextCursor;
    for (let guard = 0; cursor && guard < 10; guard++) {
      const page = await get(runId, [...base, ['limit', '2'], ['cursor', cursor]]);
      expect(page.status).toBe(200);
      seen.push(...codes(page.body));
      cursor = page.body.nextCursor;
    }
    // 1年級：P01,P02；3年級：P03,P04；~blank：P11,P12
    expect(seen).toEqual(['P01', 'P02', 'P03', 'P04', 'P11', 'P12']);
  });

  it('stats 以最終集合計算：filteredNoCourseCount 與 noCourseTotal 分開', async () => {
    const r = await get(runId, [['col.grade', '~blank'], ['limit', '200']]);
    // 最終集合 P11（班A）、P12（無報名）
    expect(r.body.stats.totalStudents).toBe(2);
    expect(r.body.stats.filteredNoCourseCount).toBe(1);
    expect(r.body.noCourseTotal).toBe(1);
  });
});

describe('UX130 (f) 需確認欄：多值徽章、「天數吻合」不是選項', () => {
  let runId: string;
  beforeEach(() => {
    runId = setup([snap('R1', 1, '一年級', '班A'), snap('R2', 1, '一年級', '班A'), snap('R3', 1, '一年級', '班A')]);
    const upd = getDatabase().prepare('UPDATE student_calculations SET tier_mismatch = ?, issues = ?, tier_comparisons = ? WHERE run_id = ? AND person_code = ?');
    // R1：tier_mismatch=1 且 issues CLASS_NOT_MAPPED＋SCHEDULE_EMPTY
    upd.run(1, JSON.stringify([{ code: 'CLASS_NOT_MAPPED', message: 'x' }, { code: 'SCHEDULE_EMPTY', message: 'x' }]),
      JSON.stringify([{ baseName: '班A', status: 'mismatch', needsReview: false }]), runId, 'R1');
    // R2：無 issue，但一筆 tier comparison needsReview=true
    upd.run(0, '[]', JSON.stringify([{ baseName: '班A', status: 'unavailable', needsReview: true }]), runId, 'R2');
    // R3：皆無
    upd.run(0, '[]', '[]', runId, 'R3');
  });
  afterEach(teardown);

  it('columnOptions.review＝天數不同、班名未對應課表、排課空時段、待核對、(空白)；不含「天數吻合」', async () => {
    const r = await get(runId, [['options', 'true']]);
    expect(r.status).toBe(200);
    expect(asMap(r.body.columnOptions.review)).toEqual({ 天數不同: 1, 班名未對應課表: 1, 排課空時段: 1, 待核對: 1, '~blank': 1 });
    // 「(空白)」恆在最後
    expect(r.body.columnOptions.review.at(-1).value).toBe('~blank');
  });

  it('col.review 以徽章文字篩選：待核對 → R2；天數不同／兩個 issue 標籤 → R1；~blank → R3', async () => {
    const cases: Array<[string, string[]]> = [
      ['待核對', ['R2']], ['天數不同', ['R1']], ['班名未對應課表', ['R1']], ['排課空時段', ['R1']], ['~blank', ['R3']], ['天數吻合', []],
    ];
    for (const [text, expected] of cases) {
      const r = await get(runId, [['col.review', text]]);
      expect(r.status, text).toBe(200);
      expect(codes(r.body), text).toEqual(expected);
    }
    // 多值欄任一項目命中即列出，依 personCode 去重（R1 兩個 issue 標籤同時選仍只出現一次）
    const both = await get(runId, [['col.review', '班名未對應課表'], ['col.review', '排課空時段']]);
    expect(codes(both.body)).toEqual(['R1']);
  });
});

describe('P-8：未帶 sort 依 personCode UTF-8 位元組序分頁（＝SQLite BINARY，UTF-16 序會相反）', () => {
  let runId: string;
  // 全形Ａ(U+FF21)：UTF-8 EF BC A1、UTF-16 FF21；𠀀(U+20000)：UTF-8 F0 A0 80 80、UTF-16 D840 DC00。
  // UTF-8 位元組序：Z1 < Ａ < 𠀀；UTF-16 碼元序：Z1 < 𠀀 < Ａ。
  const FULLWIDTH_A = 'Ａ';
  const SUPPLEMENTARY = '\u{20000}';
  beforeEach(() => {
    runId = setup([snap(SUPPLEMENTARY, 1, '一年級', '班A'), snap(FULLWIDTH_A, 1, '一年級', '班A'), snap('Z1', 1, '一年級', '班A')]);
  });
  afterEach(teardown);

  it('有 col.* 與無 col.*、limit=1 逐頁串接皆為 Z1, Ａ, 𠀀', async () => {
    const expected = ['Z1', FULLWIDTH_A, SUPPLEMENTARY];
    expect(codes((await get(runId)).body)).toEqual(expected);
    expect(codes((await get(runId, [['col.grade', '1年級']])).body)).toEqual(expected);
    for (const base of [[], [['col.grade', '1年級']]] as Array<Array<[string, string]>>) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 5; guard++) {
        const r: any = await get(runId, [...base, ['limit', '1'], ...(cursor ? [['cursor', cursor] as [string, string]] : [])]);
        expect(r.status).toBe(200);
        seen.push(...codes(r.body));
        cursor = r.body.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(expected);
    }
  });
});

/**
 * D66 P3b／UX131（03 §5.1 R3、R4、R8；取代 UX127 (c)）：所有 `sort` 走 application 層 compareCells，
 * keyset `(value, text, personCode)`，cursor v3。expected 一律依 04 UX131 手算表寫死（不以待測函式輸出產生）。
 */
const chunk = <T,>(list: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

async function pages(runId: string, base: Array<[string, string]>, limit: number): Promise<string[][]> {
  const out: string[][] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 40; guard++) {
    const r: any = await get(runId, [...base, ['limit', String(limit)], ...(cursor ? [['cursor', cursor] as [string, string]] : [])]);
    expect(r.status, JSON.stringify(base)).toBe(200);
    out.push(codes(r.body));
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  return out;
}

describe('UX131 (a) 年級排序（G13）：數值→文字（筆畫序）→空白，空白恆最後；limit=1/2/3 逐頁串接', () => {
  let runId: string;
  beforeEach(() => { runId = setup(G13); });
  afterEach(teardown);

  // 數值 1,1,3,3（P01,P02,P03,P04）→ 文字 7,小班,中班,未知,國一,國中（P10,P06,P05,P09,P08,P13）→ 空白 P11,P12
  const ASC = ['P01', 'P02', 'P03', 'P04', 'P10', 'P06', 'P05', 'P09', 'P08', 'P13', 'P11', 'P12'];
  // 降冪反轉 value 與 text：文字反序（國中,國一,未知,中班,小班,7）→ 數值 3,3,1,1（personCode 恆升冪）→ 空白仍最後
  const DESC = ['P13', 'P08', 'P09', 'P05', 'P06', 'P10', 'P03', 'P04', 'P01', 'P02', 'P11', 'P12'];

  it('sort=grade 一次取全與逐頁串接（limit 1、2、3）恆為同一順序，無重複無遺漏', async () => {
    expect(codes((await get(runId, [['sort', 'grade'], ['limit', '200']])).body)).toEqual(ASC);
    for (const limit of [1, 2, 3]) expect(await pages(runId, [['sort', 'grade']], limit), `limit=${limit}`).toEqual(chunk(ASC, limit));
  });

  it('sort=-grade：文字反序在前、數值大→小、空白仍最後；limit 1、2、3 逐頁串接', async () => {
    expect(codes((await get(runId, [['sort', '-grade'], ['limit', '200']])).body)).toEqual(DESC);
    for (const limit of [1, 2, 3]) expect(await pages(runId, [['sort', '-grade']], limit), `limit=${limit}`).toEqual(chunk(DESC, limit));
  });

  it('排序不改變 stats（最終集合人數）；與 col.* 並用時排序只作用在最終集合', async () => {
    const r = await get(runId, [['sort', 'grade'], ['limit', '3']]);
    expect(r.body.stats.totalStudents).toBe(12);
    // col.grade=7／小班／~blank（P10,P06,P11,P12）：文字 7 < 小班 → 空白（P11,P12 依 personCode）
    expect(codes((await get(runId, [['col.grade', '7'], ['col.grade', '小班'], ['col.grade', '~blank'], ['sort', 'grade'], ['limit', '200']])).body)).toEqual(['P10', 'P06', 'P11', 'P12']);
    expect(codes((await get(runId, [['col.grade', '7'], ['col.grade', '小班'], ['col.grade', '~blank'], ['sort', '-grade'], ['limit', '200']])).body)).toEqual(['P06', 'P10', 'P11', 'P12']);
  });
});

describe('UX131 (b) 姓名排序（N6）：筆畫序，明確不是碼點序', () => {
  let runId: string;
  // Q1 蔡一、Q2 黃一、Q3 林一、Q4 王一、Q5 吳一、Q6 丁一（總筆畫：丁一 3、王一 5、吳一 8、林一 9、黃一 12、蔡一 15，皆相異）
  beforeEach(() => {
    runId = setup([
      snap('Q1', 1, '一年級', '班A', '蔡一'), snap('Q2', 1, '一年級', '班A', '黃一'), snap('Q3', 1, '一年級', '班A', '林一'),
      snap('Q4', 1, '一年級', '班A', '王一'), snap('Q5', 1, '一年級', '班A', '吳一'), snap('Q6', 1, '一年級', '班A', '丁一'),
    ]);
  });
  afterEach(teardown);

  it('sort=name 升冪 Q6,Q4,Q5,Q3,Q2,Q1；sort=-name 降冪 Q1,Q2,Q3,Q5,Q4,Q6；非碼點序（碼點序為 Q6,Q5,Q3,Q4,Q1,Q2）', async () => {
    const asc = ['Q6', 'Q4', 'Q5', 'Q3', 'Q2', 'Q1'];
    const desc = ['Q1', 'Q2', 'Q3', 'Q5', 'Q4', 'Q6'];
    const ascResult = codes((await get(runId, [['sort', 'name']])).body);
    expect(ascResult).toEqual(asc);
    // 碼點序：丁 U+4E01 < 吳 U+5433 < 林 U+6797 < 王 U+738B < 蔡 U+8521 < 黃 U+9EC3
    expect(ascResult).not.toEqual(['Q6', 'Q5', 'Q3', 'Q4', 'Q1', 'Q2']);
    expect(codes((await get(runId, [['sort', '-name']])).body)).toEqual(desc);
    for (const limit of [1, 2, 3]) {
      expect(await pages(runId, [['sort', 'name']], limit), `asc limit=${limit}`).toEqual(chunk(asc, limit));
      expect(await pages(runId, [['sort', '-name']], limit), `desc limit=${limit}`).toEqual(chunk(desc, limit));
    }
  });
});

describe('UX131 (c) 合計折扣排序：bps 數值序 9000 < 9500 < 10000', () => {
  let runId: string;
  beforeEach(() => {
    runId = setup([snap('C1', 1, '一年級', '班A'), snap('C2', 1, '一年級', '班A'), snap('C3', 1, '一年級', '班A')]);
    const set = getDatabase().prepare('UPDATE student_calculations SET base_discount_bps = ? WHERE run_id = ? AND person_code = ?');
    set.run(10000, runId, 'C1'); set.run(9000, runId, 'C2'); set.run(9500, runId, 'C3');
  });
  afterEach(teardown);

  it('sort=baseDiscountBps 升冪 C2(9000),C3(9500),C1(10000)；降冪相反；limit=1/2 逐頁串接', async () => {
    expect(codes((await get(runId, [['sort', 'baseDiscountBps']])).body)).toEqual(['C2', 'C3', 'C1']);
    expect(codes((await get(runId, [['sort', '-baseDiscountBps']])).body)).toEqual(['C1', 'C3', 'C2']);
    expect(await pages(runId, [['sort', 'baseDiscountBps']], 1)).toEqual([['C2'], ['C3'], ['C1']]);
    expect(await pages(runId, [['sort', '-baseDiscountBps']], 2)).toEqual([['C1', 'C3'], ['C2']]);
  });
});

describe('UX131 (f) 安親天數排序（A6）：同值 4 的 `4` 與 `4*額` 為兩組，keyset (value, text, personCode)', () => {
  let runId: string;
  // personCode → 安親天數值,顯示：K1→4,`4*額`；K2→4,`4`；K3→3.5,`3.5`；K4→4,`4*額`；K5→空白；K6→4.5,`4.5`
  beforeEach(() => {
    runId = setup(['K1', 'K2', 'K3', 'K4', 'K5', 'K6'].map((c) => snap(c, 1, '一年級', '班A')));
    const set = getDatabase().prepare('UPDATE student_calculations SET anqin_days = ?, anqin_display = ? WHERE run_id = ? AND person_code = ?');
    set.run(4, '4*額', runId, 'K1'); set.run(4, '4', runId, 'K2'); set.run(3.5, '3.5', runId, 'K3');
    set.run(4, '4*額', runId, 'K4'); set.run(null, null, runId, 'K5'); set.run(4.5, '4.5', runId, 'K6');
  });
  afterEach(teardown);

  const ASC = ['K3', 'K2', 'K1', 'K4', 'K6', 'K5'];
  const DESC = ['K6', 'K1', 'K4', 'K2', 'K3', 'K5'];

  it('升冪 K3,K2,K1,K4,K6,K5：limit=1 頁界落在 K2(`4`)｜K1(`4*額`)；limit=1/2 無重複無遺漏', async () => {
    expect(codes((await get(runId, [['sort', 'anqinDays']])).body)).toEqual(ASC);
    expect(await pages(runId, [['sort', 'anqinDays']], 1)).toEqual([['K3'], ['K2'], ['K1'], ['K4'], ['K6'], ['K5']]);
    expect(await pages(runId, [['sort', 'anqinDays']], 2)).toEqual([['K3', 'K2'], ['K1', 'K4'], ['K6', 'K5']]);
  });

  it('降冪 K6,K1,K4,K2,K3,K5：limit=1 頁界落在 K4(`4*額`)｜K2(`4`)；空白仍最後', async () => {
    expect(codes((await get(runId, [['sort', '-anqinDays']])).body)).toEqual(DESC);
    expect(await pages(runId, [['sort', '-anqinDays']], 1)).toEqual([['K6'], ['K1'], ['K4'], ['K2'], ['K3'], ['K5']]);
    expect(await pages(runId, [['sort', '-anqinDays']], 2)).toEqual([['K6', 'K1'], ['K4', 'K2'], ['K3', 'K5']]);
  });

  it('(d) cursor v3 形狀：v2、`v: true`、`n` 與 `v` 並存、非空白缺 `t`、換 sort、未排序沿用，皆 400 指名 cursor；真實 cursor 帶 v＋t', async () => {
    const first = await get(runId, [['sort', 'anqinDays'], ['limit', '2']]);
    expect(first.status).toBe(200);
    const real = first.body.nextCursor as string;
    const body = JSON.parse(Buffer.from(real, 'base64').toString('utf8'));
    // 第 1 頁最後一列為 K2（4,`4`）：v3 keyset 帶底層值與顯示文字
    expect(body).toMatchObject({ version: 3, p: 'K2', v: 4, t: '4' });
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
    const without = (...keys: string[]) => { const next = { ...body }; for (const k of keys) delete next[k]; return next; };
    const forged: Array<[string, string, Array<[string, string]>]> = [
      ['v2 cursor（無 t）', enc({ ...without('t'), version: 2 }), [['sort', 'anqinDays']]],
      ['v2 cursor（保留 t）', enc({ ...body, version: 2 }), [['sort', 'anqinDays']]],
      ['v: true', enc({ ...body, v: true }), [['sort', 'anqinDays']]],
      ['n 與 v 並存', enc({ ...body, n: true }), [['sort', 'anqinDays']]],
      ['非空白缺 t', enc(without('t')), [['sort', 'anqinDays']]],
      ['缺 v 與 n', enc(without('v', 't')), [['sort', 'anqinDays']]],
      ['換 sort 沿用 cursor', real, [['sort', '-anqinDays']]],
      ['未排序沿用 sorted cursor', real, []],
    ];
    for (const [label, cursor, pairs] of forged) {
      const r = await get(runId, [...pairs, ['limit', '2'], ['cursor', cursor]]);
      expect(r.status, label).toBe(400);
      expect(r.body.error, label).toContain('cursor');
    }
    // 對照：未被竄改的 cursor 仍可翻到下一頁（K1,K4）
    const next = await get(runId, [['sort', 'anqinDays'], ['limit', '2'], ['cursor', real]]);
    expect(next.status).toBe(200);
    expect(codes(next.body)).toEqual(['K1', 'K4']);
  });
});

describe('UX131 (d) 空白群頁界：G13 年級 limit=1 的 cursor 以 n: true 編碼並可續翻', () => {
  let runId: string;
  beforeEach(() => { runId = setup(G13); });
  afterEach(teardown);

  it('P11（空白）之後的 cursor＝{version:3, p:P11, n:true}，續翻得 P12', async () => {
    const r = await get(runId, [['sort', 'grade'], ['limit', '11']]);
    expect(codes(r.body).at(-1)).toBe('P11');
    const body = JSON.parse(Buffer.from(r.body.nextCursor, 'base64').toString('utf8'));
    expect(body).toMatchObject({ version: 3, p: 'P11', n: true });
    expect('v' in body || 't' in body).toBe(false);
    const next = await get(runId, [['sort', 'grade'], ['limit', '11'], ['cursor', r.body.nextCursor]]);
    expect(codes(next.body)).toEqual(['P12']);
    expect(next.body.nextCursor).toBeNull();
  });

  it('文字群→空白頁界：P13（國中）之後 cursor 帶 v＋t（文字值），續翻得 P11,P12', async () => {
    const r = await get(runId, [['sort', 'grade'], ['limit', '10']]);
    expect(codes(r.body).at(-1)).toBe('P13');
    const body = JSON.parse(Buffer.from(r.body.nextCursor, 'base64').toString('utf8'));
    expect(body).toMatchObject({ version: 3, p: 'P13', v: '國中', t: '國中' });
    expect(codes((await get(runId, [['sort', 'grade'], ['limit', '10'], ['cursor', r.body.nextCursor]])).body)).toEqual(['P11', 'P12']);
  });

  it('數值→文字頁界：P04（3年級）之後 cursor 帶 v: 3、t: 3年級', async () => {
    const r = await get(runId, [['sort', 'grade'], ['limit', '4']]);
    expect(codes(r.body)).toEqual(['P01', 'P02', 'P03', 'P04']);
    expect(JSON.parse(Buffer.from(r.body.nextCursor, 'base64').toString('utf8'))).toMatchObject({ version: 3, p: 'P04', v: 3, t: '3年級' });
  });
});

describe('UX131 (e) 未帶 sort：與 person_code ASC 相同（UX128 不變）', () => {
  let runId: string;
  beforeEach(() => { runId = setup(G13); });
  afterEach(teardown);

  it('一次取全與逐頁串接皆為 P01…P13（P07 不存在）', async () => {
    const expected = ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P08', 'P09', 'P10', 'P11', 'P12', 'P13'];
    expect(codes((await get(runId, [['limit', '200']])).body)).toEqual(expected);
    for (const limit of [1, 2, 3]) expect(await pages(runId, [], limit), `limit=${limit}`).toEqual(chunk(expected, limit));
  });
});

describe('P3a 審查帶入 (1)：stats.mismatchCount 的班級範圍來自 col.enrollment（與語意 enrollmentKey 同值）', () => {
  let runId: string;
  beforeEach(() => {
    runId = setup([snap('M1', 1, '一年級', '班A\n班B'), snap('M2', 1, '一年級', '班A\n班B'), snap('M3', 1, '一年級', '班B')]);
    const set = getDatabase().prepare('UPDATE student_calculations SET tier_comparisons = ? WHERE run_id = ? AND person_code = ?');
    const tc = (...pairs: Array<[string, string]>) => JSON.stringify(pairs.map(([baseName, status]) => ({ baseName, status, needsReview: false })));
    // M1：班A match、班B mismatch；M2：班A mismatch、班B match；M3：班B match
    set.run(tc(['班A', 'match'], ['班B', 'mismatch']), runId, 'M1');
    set.run(tc(['班A', 'mismatch'], ['班B', 'match']), runId, 'M2');
    set.run(tc(['班B', 'match']), runId, 'M3');
  });
  afterEach(teardown);

  it('col.enrollment=班A → 1（只有 M2 在班A mismatch）；enrollmentKey=班A → 1；兩者並存 → 1；不帶班級 → 2（M1、M2）', async () => {
    expect((await get(runId, [['col.enrollment', '班A']])).body.stats.mismatchCount).toBe(1);
    expect((await get(runId, [['enrollmentKey', '班A']])).body.stats.mismatchCount).toBe(1);
    expect((await get(runId, [['enrollmentKey', '班A'], ['col.enrollment', '班A']])).body.stats.mismatchCount).toBe(1);
    expect((await get(runId, [])).body.stats.mismatchCount).toBe(2);
    // 對照：班B 的 mismatch 只有 M1
    expect((await get(runId, [['col.enrollment', '班B']])).body.stats.mismatchCount).toBe(1);
    // 帶 sort 時 stats 不變
    expect((await get(runId, [['col.enrollment', '班A'], ['sort', 'name']])).body.stats.mismatchCount).toBe(1);
  });
});

describe('P3a 審查帶入 (2)：排序請求併用 col.*，cursor v3 逐頁取完', () => {
  let runId: string;
  beforeEach(() => {
    // 班B：T1→5,`5`；T2→4,`4`；T3→4,`4*額`；T4→空白；T5→3,`3`；T7→空白。班A：T6→9,`9`（被 col.enrollment=班B 排除）
    runId = setup([
      snap('T1', 1, '一年級', '班B'), snap('T2', 1, '一年級', '班B'), snap('T3', 1, '一年級', '班B'), snap('T4', 1, '一年級', '班B'),
      snap('T5', 1, '一年級', '班B'), snap('T6', 1, '一年級', '班A'), snap('T7', 1, '一年級', '班B'),
    ]);
    const set = getDatabase().prepare('UPDATE student_calculations SET anqin_days = ?, anqin_display = ? WHERE run_id = ? AND person_code = ?');
    set.run(5, '5', runId, 'T1'); set.run(4, '4', runId, 'T2'); set.run(4, '4*額', runId, 'T3'); set.run(null, null, runId, 'T4');
    set.run(3, '3', runId, 'T5'); set.run(9, '9', runId, 'T6'); set.run(null, null, runId, 'T7');
  });
  afterEach(teardown);

  it('col.enrollment=班B&sort=-anqinDays&limit=1 逐頁：T1,T3,T2,T5,T4,T7（降冪 `4*額`(T3) 先於 `4`(T2)，personCode 不能反過來決定；空白群內依 personCode）', async () => {
    const expected = ['T1', 'T3', 'T2', 'T5', 'T4', 'T7'];
    expect(await pages(runId, [['col.enrollment', '班B'], ['sort', '-anqinDays']], 1)).toEqual(expected.map((c) => [c]));
    expect(await pages(runId, [['col.enrollment', '班B'], ['sort', '-anqinDays']], 4)).toEqual([expected.slice(0, 4), expected.slice(4)]);
    const first = await get(runId, [['col.enrollment', '班B'], ['sort', '-anqinDays'], ['limit', '1']]);
    expect(first.body.stats).toMatchObject({ totalStudents: 6, classScopeTotal: 6 });
    // 換 col.* 沿用舊 cursor → 400 指名 cursor
    const other = await get(runId, [['col.enrollment', '班A'], ['sort', '-anqinDays'], ['limit', '1'], ['cursor', first.body.nextCursor]]);
    expect(other.status).toBe(400);
    expect(other.body.error).toContain('cursor');
  });
});
