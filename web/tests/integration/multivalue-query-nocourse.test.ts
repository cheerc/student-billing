import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { activateImport } from '@/application/activate-import';
import { parseClassTokens, type StudentSnapshot } from '@/domain/students';
import { GET as runGET } from '@/app/api/v1/runs/[runId]/students/route';
import { GET as previewGET } from '@/app/api/v1/imports/[previewId]/students/route';

/** B1／UX25、UX29：合成名冊 → 持久化 → 真實 activate → 真實 GET route，沒有 mock 或新模組 import。 */
const MATH = '國小數學-一A';
const ENGLISH = '兒童美語-Gino';
const CARE = '國小輔導-一A';
const IMP = 'imp_b1_synthetic';
const code = (i: number) => `STUB1_${String(i).padStart(4, '0')}`;

function student(i: number, classes = `${MATH}[團]`): StudentSnapshot {
  const grade = (i % 6) + 1;
  return {
    personCode: code(i), name: `合成學生${i}`, branch: i % 2 ? '南校' : '北校',
    grade, gradeRaw: `${grade}年級`, gradeStatus: 'valid', contact: null, schoolInfo: null,
    tagsRaw: '', tags: [], notesRaw: '', enrollments: parseClassTokens(classes), sourceRow: i + 2,
  };
}

function roster(size = 205): StudentSnapshot[] {
  const rows = Array.from({ length: size }, (_, i) => student(i));
  rows[0] = student(0, '');
  rows[1] = student(1, '國小輔導-寫功課[團]');
  rows[2] = student(2, '交通車[團]');
  rows[3] = student(3, `${MATH}[團](2026-01-01離班)`);
  rows[4] = student(4, '合成未知班[團]');
  rows[5] = student(5, `${CARE}[團][未知級距]`);
  rows[6] = { ...student(6, ''), tagsRaw: '員工家屬', tags: ['員工家屬'] };
  rows[7] = student(7, `${MATH}[團]\n${ENGLISH}[團]`);
  rows[8] = { ...student(8, `${CARE}[團]\n${MATH}[團]`), grade: 1, gradeRaw: '一年級', tagsRaw: '園內生', tags: ['園內生'] };
  rows[9] = { ...student(9, `${CARE}[團]`), grade: 1, gradeRaw: '一年級', tagsRaw: '特殊折扣95折', tags: ['特殊折扣95折'] };
  rows[10] = { ...student(10, `${CARE}[團]`), grade: 1, gradeRaw: '一年級', tagsRaw: '安課額外扣0.5天', tags: ['安課額外扣0.5天'] };
  rows[11] = { ...student(11), grade: null, gradeRaw: '未知', gradeStatus: 'unavailable', branch: null };
  rows[12] = { ...student(12), tagsRaw: '有兄弟姊妹折扣', tags: ['有兄弟姊妹折扣'] };
  rows[13] = { ...student(13), branch: '北校\r\n南校' };
  rows[14] = student(14, '~班,甲[團]');
  rows[15] = student(15, `${MATH}[團]\n國小數學-二A[團]`);
  rows[size - 1] = { ...student(size - 1, '後頁獨有班[團]'), branch: '後頁獨有分校' };
  return rows;
}

function save(id: string, rows: StudentSnapshot[]) {
  saveImportBatch(getDatabase(), {
    id, fileName: 'synthetic.xlsx', fileHash: `synthetic-${id}`, contentHash: `content-${id}`,
    sheetName: 'Sheet1', headerMap: {}, parserVersion: '1.0.0', scopeNote: '全合成 B1',
    rowCount: rows.length, status: 'ready', createdAt: '2026-09-30T00:00:00.000Z',
  }, rows);
}

async function query(runId: string, pairs: Array<[string, string]> = []) {
  const params = new URLSearchParams(pairs);
  const response = await runGET(new NextRequest(`http://127.0.0.1:3100/api/v1/runs/${runId}/students?${params}`), {
    params: Promise.resolve({ runId }),
  });
  return { status: response.status, body: await response.json() };
}

async function preview(pairs: Array<[string, string]> = []) {
  const params = new URLSearchParams(pairs);
  const response = await previewGET(new NextRequest(`http://127.0.0.1:3100/api/v1/imports/${IMP}/students?${params}`), {
    params: Promise.resolve({ previewId: IMP }),
  });
  return { status: response.status, body: await response.json() };
}

const codes = (body: any): string[] => body.items.map((s: any) => s.personCode);

describe('B1 多值查詢／全 run 選項／無課程真實 API', () => {
  let tempDir: string;
  let runId: string;
  let rows: StudentSnapshot[];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-b1-query-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    if (global.__sqlite_db__) global.__sqlite_db__.close();
    global.__sqlite_db__ = undefined;
    rows = roster();
    save(IMP, rows);
    runId = activateImport(getDatabase(), { importId: IMP, expectedRevision: 0, idempotencyKey: 'activate-b1' }).runId;
  });

  afterEach(() => {
    global.__sqlite_db__?.close();
    global.__sqlite_db__ = undefined;
    delete process.env.DATABASE_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('班級同欄 OR、跨欄 AND；同學生同屬兩班只計一次，名單/統計同條件', async () => {
    const pairs: Array<[string, string]> = [['enrollmentKey', MATH], ['enrollmentKey', ENGLISH], ['grade', '1'], ['grade', '2']];
    const { status, body } = await query(runId, [...pairs, ['limit', '200']]);
    const selected = rows.filter((s) => s.enrollments.some((e) => [MATH, ENGLISH].includes(e.baseName)) && [1, 2].includes(s.grade!));
    const scope = rows.filter((s) => s.enrollments.some((e) => [MATH, ENGLISH].includes(e.baseName)));
    expect(status).toBe(200);
    expect(codes(body)).toEqual(selected.map((s) => s.personCode));
    expect(body.totalStudents).toBe(selected.length);
    expect(body.stats.totalStudents).toBe(selected.length);
    expect(body.stats.classScopeTotal).toBe(scope.length);
    expect(codes(body).filter((c) => c === code(7))).toHaveLength(1);
  });

  it('全部、不選任何值、(空白) 三態分開；無課程僅 0/6，classScope 和全批無課程總數不混', async () => {
    const all = await query(runId);
    expect(all.status).toBe(200);
    expect(all.body.totalStudents).toBe(205);
    expect(all.body.noCourseTotal).toBe(2);
    const blank = await query(runId, [['enrollmentKey', '~blank']]);
    expect(blank.status).toBe(200);
    expect(codes(blank.body)).toEqual([code(0), code(6)]);
    expect(blank.body.stats).toMatchObject({ totalStudents: 2, classScopeTotal: 2, filteredNoCourseCount: 2, issuesCount: 1 });
    expect(blank.body.noCourseTotal).toBe(2);
    const none = await query(runId, [['grade', '~none']]);
    expect(none.status).toBe(200);
    expect(none.body.items).toEqual([]);
    expect(none.body.totalStudents).toBe(0);
    expect(Object.values(none.body.stats).every((n) => n === 0)).toBe(true);
    expect(none.body.noCourseTotal).toBe(2);
    expect((await query(runId, [['grade', '']])).body.totalStudents).toBe(205);
  });

  it.each([
    [0, true], [1, false], [2, false], [3, false], [4, false], [5, false], [6, true],
  ])('UX29 合成邊界列 %i：無課程=%s，preview/run 人數與名單一致', async (i, noCourse) => {
    const pairs: Array<[string, string]> = [['enrollmentKey', '~blank'], ['q', code(i)]];
    for (const result of [await query(runId, pairs), await preview(pairs)]) {
      expect(result.status).toBe(200);
      expect(codes(result.body)).toEqual(noCourse ? [code(i)] : []);
      expect(result.body.totalStudents).toBe(noCourse ? 1 : 0);
      expect(result.body.noCourseTotal).toBe(2);
      expect(result.body.stats.filteredNoCourseCount).toBe(noCourse ? 1 : 0);
    }
    if (i === 5) expect(rows[i].enrollments[0].parseStatus).toBe('needs_review');
    if (i === 6) {
      const only = await query(runId, [['q', code(i)]]);
      expect(only.body.items[0].issues.some((issue: any) => issue.code === 'STAFF_FAMILY_NO_DISCOUNT')).toBe(true);
      expect(only.body.stats.issuesCount).toBe(1);
    }
  });

  it('hasClass=false 保留折扣科數語意，包含有課程的寫功課/交通車，不等於無課程', async () => {
    const result = await query(runId, [['hasClass', 'false'], ['limit', '200']]);
    expect(result.status).toBe(200);
    expect(codes(result.body)).toContain(code(1));
    expect(codes(result.body)).toContain(code(2));
    expect(result.body.stats.filteredNoCourseCount).toBe(2);
  });

  it('~blank 可以與班級 OR；~~ 跳脫、逗號不拆；分校查詢多值且保留 CRLF 集合語意', async () => {
    const blankOrMath = await query(runId, [['enrollmentKey', '~blank'], ['enrollmentKey', MATH], ['limit', '200']]);
    const expected = rows.filter((s) => !s.enrollments.length || s.enrollments.some((e) => e.baseName === MATH));
    expect(codes(blankOrMath.body)).toEqual(expected.map((s) => s.personCode));
    expect(codes((await query(runId, [['enrollmentKey', '~~班,甲']])).body)).toEqual([code(14)]);
    const branch = await query(runId, [['branch', '北校'], ['branch', '南校'], ['limit', '200']]);
    expect(branch.status).toBe(200);
    expect(branch.body.totalStudents).toBe(203);
    expect(codes(branch.body)).toContain(code(13));
  });

  it.each(['specialDiscount', 'hasExtraDeduction', 'sibling', 'internalStudent'])('%s 真正生效，true/false OR 為全部，false不是未設', async (key) => {
    const target = { specialDiscount: 9, hasExtraDeduction: 10, sibling: 12, internalStudent: 8 }[key]!;
    const yes = await query(runId, [[key, 'true']]);
    expect(yes.status).toBe(200);
    expect(codes(yes.body)).toEqual([code(target)]);
    const no = await query(runId, [[key, 'false']]);
    expect(no.body.totalStudents).toBe(204);
    const both = await query(runId, [[key, 'true'], [key, 'false']]);
    expect(both.body.totalStudents).toBe(205);
  });

  it('問題類型 OR 與年級 AND；hasIssues/tierMismatch true/false 集合不丟學生', async () => {
    const result = await query(runId, [['issueCode', 'STAFF_FAMILY_NO_DISCOUNT'], ['issueCode', 'DUPLICATE_SUBJECT_ENROLLMENT']]);
    expect(result.status).toBe(200);
    expect(codes(result.body)).toEqual([code(6), code(15)]);
    expect(result.body.stats.issuesCount).toBe(2);
    expect(codes((await query(runId, [['issueCode', 'STAFF_FAMILY_NO_DISCOUNT'], ['issueCode', 'DUPLICATE_SUBJECT_ENROLLMENT'], ['grade', '1']])).body)).toEqual([code(6)]);
    expect((await query(runId, [['hasIssues', 'true'], ['hasIssues', 'false']])).body.totalStudents).toBe(205);
    // issue #59 / spec03 §127：tierMismatch true/false 僅收錄有 match 或 mismatch 者；
    // 此名冊僅 row 8, 9, 10 為 match，其餘 202 人為 not_applicable／unavailable 不納入
    expect((await query(runId, [['tierMismatch', 'true'], ['tierMismatch', 'false']])).body.totalStudents).toBe(3);
    const comparison = await query(runId, [['enrollmentKey', '交通車'], ['enrollmentKey', CARE], ['tierComparison', 'not_applicable'], ['tierComparison', 'unavailable']]);
    expect(comparison.status).toBe(200);
    expect(codes(comparison.body)).toContain(code(2));
    expect(codes(comparison.body)).toContain(code(5));
  });

  it('0 與 null 不混：0 是有效 bps 值，~blank 才匹配 null；年級未知可與一般值 OR', async () => {
    const zero = await query(runId, [['baseDiscountBps', '0']]);
    expect(zero.status).toBe(200);
    expect(zero.body.items).toEqual([]); // 此合成名冊沒有 0 bps，不可忽略 0 成全部
    const blank = await query(runId, [['baseDiscountBps', '~blank']]);
    // d-20261002160111112854-66：無課程學生合計折扣預設 10000，~blank 匹配 0 人
    expect(codes(blank.body)).toEqual([]);
    const tenThousand = await query(runId, [['baseDiscountBps', '10000']]);
    expect(codes(tenThousand.body)).toContain(code(0));
    expect(codes(tenThousand.body)).toContain(code(6));
    const grade = await query(runId, [['grade', '~blank'], ['grade', '1'], ['limit', '200']]);
    expect(codes(grade.body)).toEqual(rows.filter((s) => s.grade === null || s.grade === 1).map((s) => s.personCode));
  });

  it('兩個天數欄可以同時篩，多值/null 不讓任何一欄被覆蓋', async () => {
    const result = await query(runId, [['anqinDays', '~blank'], ['anqinDays', '5'], ['tutoringDays', '~blank'], ['limit', '200']]);
    expect(result.status).toBe(200);
    expect(result.body.items.length).toBeGreaterThan(0);
    expect(result.body.items.every((s: any) => (s.anqinDays === null || s.anqinDays === 5) && s.tutoringDays === null)).toBe(true);
    expect(result.body.totalStudents).toBe(result.body.items.length);
  });

  it('適用率只讀持久化學生欄：已選care低年級取anqin，基本95折與園內生90折不混', async () => {
    const result = await query(runId, [['enrollmentKey', CARE], ['applicableDiscountBps', '9000']]);
    expect(result.status).toBe(200);
    expect(codes(result.body)).toEqual([code(8)]);
    const options = await query(runId, [['options', 'true'], ['enrollmentKey', CARE]]);
    expect(options.status).toBe(200);
    expect(options.body.options.applicableDiscountBps.some((o: any) => o.value === '9000')).toBe(true);
    const unavailable = await query(runId, [['options', 'true'], ['enrollmentKey', '交通車']]);
    expect(unavailable.status).toBe(200);
    expect(unavailable.body.applicableRateContext.status).toBe('not_configured');
    expect(unavailable.body.options.applicableDiscountBps).toEqual([]);
  });

  it('options 值宇宙涵蓋205人不受limit；班級count受grade=1影響，後頁值／空白／跳脫均保留，不提供姓名/代碼', async () => {
    const first = await query(runId, [['limit', '200']]);
    expect(first.body.items).toHaveLength(200);
    expect(codes(first.body)).not.toContain(code(204));
    const { status, body } = await query(runId, [['options', 'true'], ['limit', '1'], ['grade', '1']]);
    expect(status).toBe(200);
    expect(body.options.enrollmentKey).toContainEqual({ value: '後頁獨有班', count: 1 });
    expect(body.options.enrollmentKey).toContainEqual({ value: '~blank', count: 2 });
    // 列14為三年級，不符合其他欄grade=1，但仍是run中有效值（count=0）。
    expect(body.options.enrollmentKey).toContainEqual({ value: '~~班,甲', count: 0 });
    expect(body.options.branch).toContainEqual({ value: '後頁獨有分校', count: 1 });
    expect(body.options.enrollmentKey.find((o: any) => o.value === MATH).count).toBe(rows.filter((s) => s.grade === 1 && s.enrollments.some((e) => e.baseName === MATH)).length);
    expect(body.options).not.toHaveProperty('q');
    expect(body.options).not.toHaveProperty('name');
    expect(body.options).not.toHaveProperty('personCode');
    expect(JSON.stringify(body)).not.toContain('合成學生');
    expect(JSON.stringify(body)).not.toContain(code(0));
  });

  it('cursor 與run/import/正規化條件綁定；等價順序可續頁，變更條件與切run回400', async () => {
    const selected: Array<[string, string]> = [['grade', '1'], ['grade', '2']];
    const first = await query(runId, [...selected, ['limit', '2']]);
    expect(first.status).toBe(200);
    expect(first.body.nextCursor).toBeTruthy();
    const same = await query(runId, [['grade', '2'], ['grade', '1'], ['grade', '1'], ['cursor', first.body.nextCursor], ['limit', '200']]);
    expect(same.status).toBe(200);
    expect(codes(same.body).some((c) => codes(first.body).includes(c))).toBe(false);
    expect(same.body.totalStudents).toBe(first.body.totalStudents);
    expect((await query(runId, [['grade', '3'], ['cursor', first.body.nextCursor]])).status).toBe(400);
    save('imp_b1_other', [student(0, '另一run獨有班[團]')]);
    const newer = activateImport(getDatabase(), { importId: 'imp_b1_other', expectedRevision: 1, idempotencyKey: 'activate-other' }).runId;
    expect((await query(newer, [...selected, ['cursor', first.body.nextCursor]])).status).toBe(400);
    const oldOptions = await query(runId, [['options', 'true']]);
    const newOptions = await query(newer, [['options', 'true']]);
    expect(oldOptions.body.options.enrollmentKey.some((o: any) => o.value === '後頁獨有班')).toBe(true);
    expect(oldOptions.body.options.enrollmentKey.some((o: any) => o.value === '另一run獨有班')).toBe(false);
    expect(newOptions.body.options.enrollmentKey).toEqual([{ value: '另一run獨有班', count: 1 }]);
  });

  it('preview 多值與cursor同樣綁條件/import，不靜默使用舊cursor', async () => {
    const first = await preview([['grade', '1'], ['grade', '2'], ['limit', '2']]);
    expect(first.status).toBe(200);
    const changed = await preview([['grade', '3'], ['cursor', first.body.nextCursor]]);
    expect(changed.status).toBe(400);
    const same = await preview([['grade', '2'], ['grade', '1'], ['cursor', first.body.nextCursor], ['limit', '200']]);
    expect(same.status).toBe(200);
    expect(same.body.totalStudents).toBe(first.body.totalStudents);
    expect(codes(same.body).some((c) => codes(first.body).includes(c))).toBe(false);
  });

  it.each(([
    [['grade', 'oops']], [['grade', '1x']], [['hasIssues', 'maybe']],
    [['grade', '~none'], ['grade', '1']], [['grade', '~unknown']],
    [['scheduleStatus', 'calculated']], [['sort', 'name']], [['mappingStatus', 'mapped']],
    [['applicableDiscountBps', '9000']], [['enrollmentKey', MATH], ['enrollmentKey', ENGLISH], ['applicableDiscountBps', '9000']],
    [['q', 'a'], ['q', 'b']], [['limit', '2x']], [['unknown', '']],
    [['hasIssues', 'false'], ['issueCode', 'STAFF_FAMILY_NO_DISCOUNT']],
    [['tierMismatch', 'false'], ['tierComparison', 'mismatch']],
  ] as Array<Array<[string, string]>>).map((pairs) => ({ pairs })))('無效/未實作/矛盾參數 $pairs 明確400，不忽略', async ({ pairs }) => {
    expect((await query(runId, pairs)).status).toBe(400);
  });

  it.each(['sort', 'mappingStatus', 'anqinDays', 'options'])('preview 不接受%s，正式計算欄/未實作參數指名400', async (key) => {
    const result = await preview([[key, key === 'options' ? 'true' : '1']]);
    expect(result.status).toBe(400);
    expect(result.body.error).toContain(key);
  });

  it('搜索 q 為字面子字串，%/_ 不可當作 SQL wildcard 取得全部', async () => {
    for (const q of ['%', '_']) {
      const result = await query(runId, [['q', q]]);
      expect(result.status).toBe(200);
      expect(result.body.totalStudents).toBe(q === '_' ? 205 : 0); // 合成代碼含 _，姓名不含 %
    }
  });

  function emptyClassRun() {
    const importId = 'imp_b1_empty_class';
    const students = [student(0, ''), student(1, '[團]'), student(2, '~empty[團]')];
    expect(students[1].enrollments).toHaveLength(1);
    expect(students[1].enrollments[0].baseName).toBe('');
    save(importId, students);
    const id = activateImport(getDatabase(), { importId, expectedRevision: 1, idempotencyKey: 'activate-empty' }).runId;
    const readPreview = async (pairs: Array<[string, string]>) => {
      const response = await previewGET(new NextRequest(`http://127.0.0.1:3100/api/v1/imports/${importId}/students?${new URLSearchParams(pairs)}`), { params: Promise.resolve({ previewId: importId }) });
      return { status: response.status, body: await response.json() };
    };
    return { id, readPreview };
  }

  it('空班名 ~empty 命中有 enrollment 的空 baseName；兩端不計入無課程', async () => {
    const { id, readPreview } = emptyClassRun();
    for (const result of [await query(id, [['enrollmentKey', '~empty']]), await readPreview([['enrollmentKey', '~empty']])]) {
      expect(result.status).toBe(200);
      expect(codes(result.body)).toEqual([code(1)]);
      expect(result.body.totalStudents).toBe(1);
      expect(result.body.noCourseTotal).toBe(1);
      expect(result.body.stats.filteredNoCourseCount).toBe(0);
    }
  });

  it('空班名 ~empty 與 ~blank 不混：blank只命中零報名，混用回400', async () => {
    const { id, readPreview } = emptyClassRun();
    for (const result of [await query(id, [['enrollmentKey', '~blank']]), await readPreview([['enrollmentKey', '~blank']])]) {
      expect(result.status).toBe(200);
      expect(codes(result.body)).toEqual([code(0)]);
      expect(result.body.stats.filteredNoCourseCount).toBe(1);
    }
    expect((await query(id, [['enrollmentKey', '~empty'], ['enrollmentKey', '~blank']])).status).toBe(400);
    expect((await readPreview([['enrollmentKey', '~empty'], ['enrollmentKey', '~blank']])).status).toBe(400);
  });

  it('空班名 options 回 ~empty 與 unparsedClassLabel，不回空字串可選值；空白與解析盲點分開', async () => {
    const { id } = emptyClassRun();
    const result = await query(id, [['options', 'true']]);
    expect(result.status).toBe(200);
    expect(result.body.options.enrollmentKey).toContainEqual({ value: '~empty', count: 1, labelKey: 'unparsedClassLabel' });
    expect(result.body.options.enrollmentKey).toContainEqual({ value: '~blank', count: 1 });
    expect(result.body.options.enrollmentKey.every((o: any) => o.value !== '')).toBe(true);
    expect(result.body.noCourseTotal).toBe(1);
  });

  it('空班名保留字的字面值以 ~~ 跳脫，不把實際班名 ~empty 誤當空 baseName', async () => {
    const { id, readPreview } = emptyClassRun();
    for (const result of [await query(id, [['enrollmentKey', '~~empty']]), await readPreview([['enrollmentKey', '~~empty']])]) {
      expect(result.status).toBe(200);
      expect(codes(result.body)).toEqual([code(2)]);
    }
  });

  it('477人實際API多值與options暖機後10次，記中位數/p95；GET不寫DB', async () => {
    const db = getDatabase();
    save('imp_b1_perf', roster(477));
    const perfRun = activateImport(db, { importId: 'imp_b1_perf', expectedRevision: 1, idempotencyKey: 'activate-perf' }).runId;
    const snapshot = () => Object.fromEntries(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(
        ({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]
      )
    );
    const before = snapshot();
    for (const pairs of [[['grade', '1'], ['grade', '2'], ['branch', '北校'], ['branch', '南校']], [['options', 'true']]] as Array<Array<[string, string]>>) {
      expect((await query(perfRun, pairs)).status).toBe(200);
      const timings: number[] = [];
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        expect((await query(perfRun, pairs)).status).toBe(200);
        timings.push(performance.now() - start);
      }
      timings.sort((a, b) => a - b);
      console.log(`[B1 api perf] ${pairs[0][0]} 477人 median=${timings[5].toFixed(2)}ms p95=${timings[9].toFixed(2)}ms`);
      expect(timings[9]).toBeLessThan(200);
    }
    expect(snapshot()).toEqual(before);
  });
});
