import { describe, it, expect, afterEach, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import JSZip from 'jszip';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { POST as previewPOST } from '@/app/api/v1/imports/preview/route';
import { POST as activatePOST } from '@/app/api/v1/imports/[previewId]/activate/route';
import { GET as runGET } from '@/app/api/v1/runs/[runId]/students/route';
import { RosterChangesDetails } from '@/components/imports/roster-changes-details';
import { formatDiscountBps } from '@/application/roster-changes';
import type { RosterChange } from '@/application/roster-changes';

/**
 * T4（第四輪瀏覽器驗收用合成名冊）：產出器契約 + **manifest 手算預期 vs 產品實際**的比對。
 *
 * manifest 的 expected 全部是依 spec 手算（`scripts/round4-fixtures.ts` 逐列附 specRefs）。
 * 本檔的 role 是「找出錯誤」：手算寫錯或產品有缺陷時，這裡會失敗——**不回填 manifest 讓它變綠**。
 * 匯入一律走與 UI 相同的 multipart POST /api/v1/imports/preview → activate → variant preview。
 */

const roots: string[] = [];
const script = path.resolve(__dirname, '../../scripts/round4-fixtures.ts');
const loader = path.resolve(__dirname, '../../node_modules/tsx/dist/loader.mjs');
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-round4-fixtures-')); roots.push(dir); return dir; };

afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
afterAll(() => { global.__sqlite_db__?.close(); global.__sqlite_db__ = undefined; });

/** 私有來源攔截：空 cwd＋preload，禁止以「沒操作過」推論沒讀來源。 */
function generate(dir: string) {
  const out = path.join(dir, 'output');
  const preload = path.join(dir, 'deny-private.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs'); const path = require('node:path');
const forbidden = ${JSON.stringify([path.resolve(__dirname, '../../../data'), '/Users/cheerc/Projects/student-billing/data'])};
function check(p) { if (typeof p !== 'string' && !Buffer.isBuffer(p)) return; const target = path.resolve(String(p)); if (forbidden.some(root => target === root || target.startsWith(root + path.sep))) throw new Error('禁止讀取私有來源: ' + target); }
for (const name of ['readFileSync','openSync','createReadStream']) { const original = fs[name]; fs[name] = function(p, ...rest) { check(p); return original.call(this, p, ...rest); }; }
for (const name of ['readFile','open']) { const original = fs.promises[name]; fs.promises[name] = function(p, ...rest) { check(p); return original.call(this, p, ...rest); }; }
`);
  const result = spawnSync(process.execPath, ['--require', preload, '--import', loader, script, '--out', out], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  expect(result.error, 'CLI 必須正常退出，不能留下程序').toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return out;
}

interface CaseEntry {
  code: string;
  tests: string;
  acceptance: string[];
  baselineRow: { classes: string[]; grade: string; tags: string[] } | null;
  variantRow: { classes: string[]; grade: string; tags: string[] } | null;
  expected: Record<string, unknown>;
  specRefs: string[];
}

interface Manifest {
  synthetic: boolean;
  students: { baseline: number; variant: number; cases: number };
  cases: CaseEntry[];
  facetJourney: Array<{ step: number; action: string; panelCounts: Record<string, number>; resultCount: number }>;
}

const COLUMN_OF: Record<string, string> = {
  baseDiscountBps: 'base_discount_bps',
  subjectCount: 'subject_count',
  applicableAnqinBps: 'applicable_anqin_bps',
  applicableTutoringBps: 'applicable_tutoring_bps',
  applicableMathBps: 'applicable_math_bps',
  applicableEnglishBps: 'applicable_english_bps',
  anqinDays: 'anqin_days',
  tutoringDays: 'tutoring_days',
};

async function uploadPreview(file: string) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), path.basename(file));
  const response = await previewPOST(new Request('http://127.0.0.1:3000/api/v1/imports/preview', { method: 'POST', body: form }));
  return { status: response.status, body: (await response.json()) as { previewId: string; issues: string[]; stats: { totalStudents: number }; rosterDiff: { changes: RosterChange[] } } };
}

interface OptionCounts { grades: Map<string, number>; classes: Map<string, number>; sibling: Map<string, number> }
interface ProductRun {
  runId: string;
  baselineRunId: string;
  baselineCount: number;
  variantCount: number;
  changes: Map<string, { status: string; enrollmentText: string[]; classDiscountText: string[] }>;
  rows: Map<string, Record<string, unknown>>;
  baselineRows: Map<string, Record<string, unknown>>;
  optionsAll: OptionCounts;
  optionsGrade5: OptionCounts;
  optionsClass2A: OptionCounts;
  optionsSiblingTrue: OptionCounts;
}

async function productRun(out: string): Promise<ProductRun> {
  const baseline = await uploadPreview(path.join(out, 'round4-baseline.xlsx'));
  expect(baseline.status, JSON.stringify(baseline.body)).toBe(200);
  expect(baseline.body.issues, 'baseline 解析不得有問題').toEqual([]);
  const previewId = baseline.body.previewId;
  const activated = await activatePOST(
    new NextRequest(`http://127.0.0.1:3000/api/v1/imports/${previewId}/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, idempotencyKey: 'round4-baseline', asOfDate: '2026-10-03' }),
    }),
    { params: Promise.resolve({ previewId }) }
  );
  expect(activated.status, await activated.clone().text()).toBe(200);
  const runId = ((await activated.json()) as { runId: string }).runId;
  const variant = await uploadPreview(path.join(out, 'round4-variant.xlsx'));
  expect(variant.status, JSON.stringify(variant.body)).toBe(200);
  expect(variant.body.issues, 'variant 解析不得有問題').toEqual([]);

  // 逐人明細走與 UI 相同的元件（畫面只呈現 application 輸出）
  const html = renderToStaticMarkup(React.createElement(RosterChangesDetails, { changes: variant.body.rosterDiff.changes }));
  const rowOf = (code: string) => {
    const row = html.match(/<tr data-status[\s\S]*?<\/tr>/g)?.find((r) => r.includes(`>${code}<`));
    if (!row) throw new Error(`畫面找不到 ${code} 的明細列`);
    return row;
  };
  // 抽取「純文字」：去標籤、還原跳脫，才能與 manifest 的手算文案逐字比對。
  const textOf = (html: string) => html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#10;/g, '\n').trim();
  const listOf = (code: string, field: 'enrollment' | 'class-discount') => {
    const cell = rowOf(code).match(new RegExp(`<td data-field="${field}">([\\s\\S]*?)</td>`))?.[1] ?? '';
    const items = [...cell.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => textOf(m[1]));
    return items.length ? items : [textOf(cell)];
  };
  const changes = new Map(variant.body.rosterDiff.changes.map((change) => [change.personCode, {
    status: change.isNew ? '新學生' : change.isRemoved ? '已不在名單' : '異動',
    enrollmentText: listOf(change.personCode, 'enrollment'),
    classDiscountText: listOf(change.personCode, 'class-discount'),
  }]));

  // after 手算要對「本次（variant）名冊」的 run；另啟用 variant 以取得 after 側計算結果。
  const variantActivated = await activatePOST(
    new NextRequest(`http://127.0.0.1:3000/api/v1/imports/${variant.body.previewId}/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, idempotencyKey: 'round4-variant', asOfDate: '2026-10-03' }),
    }),
    { params: Promise.resolve({ previewId: variant.body.previewId }) }
  );
  expect(variantActivated.status, await variantActivated.clone().text()).toBe(200);
  const variantRunId = ((await variantActivated.json()) as { runId: string }).runId;

  const db = getDatabase();
  const readRows = (id: string) => {
    const map = new Map<string, Record<string, unknown>>();
    for (const row of db.prepare('SELECT * FROM student_calculations WHERE run_id = ?').all(id) as Array<Record<string, unknown>>) {
      map.set(row.person_code as string, row);
    }
    return map;
  };
  const baselineRows = readRows(runId);
  const rows = readRows(variantRunId);
  const options = async (params: Array<[string, string]>) => {
    const response = await runGET(new NextRequest(`http://127.0.0.1:3000/api/v1/runs/${runId}/students?${new URLSearchParams(params)}`), { params: Promise.resolve({ runId }) });
    expect(response.status, await response.clone().text()).toBe(200);
    const data = (await response.json()) as { options: Record<string, Array<{ value: string; count: number }>> };
    const toMap = (key: string) => new Map((data.options[key] ?? []).map((o) => [o.value, o.count]));
    return { grades: toMap('grade'), classes: toMap('enrollmentKey'), sibling: toMap('sibling') };
  };
  const optionsAll = await options([['options', 'true']]);
  const optionsGrade5 = await options([['options', 'true'], ['grade', '5']]);
  // 篩選面板送出的是解析後 baseName（wire），非 rawToken（實測：[團] 形式回 0 人）。
  const optionsClass2A = await options([['options', 'true'], ['enrollmentKey', '國小數學-二A']]);
  const optionsSiblingTrue = await options([['options', 'true'], ['sibling', 'true']]);
  return { runId, baselineRunId: runId, baselineCount: baseline.body.stats.totalStudents, variantCount: variant.body.stats.totalStudents, changes, rows, baselineRows, optionsAll, optionsGrade5, optionsClass2A, optionsSiblingTrue };
}

describe('T4：產出器契約（CLI、OOXML 形狀、manifest 結構）', () => {
  it('--help 說明輸出；空目錄可產出；既有檔案拒絕覆寫；repo／data 內拒絕', () => {
    const dir = temp();
    const run = (args: string[]) => spawnSync(process.execPath, ['--import', loader, script, ...args], { cwd: dir, encoding: 'utf8', timeout: 60000 });
    const help = run(['--help']);
    expect(help.status, help.stderr).toBe(0);
    for (const token of ['round4-baseline.xlsx', 'round4-variant.xlsx', 'manifest.json', '--out']) expect(help.stdout).toContain(token);

    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    expect(run(['--out', empty]).status, '空的既有目錄可產出').toBe(0);
    const clash = path.join(dir, 'clash');
    fs.mkdirSync(clash);
    fs.writeFileSync(path.join(clash, 'manifest.json'), 'x');
    const clashResult = run(['--out', clash]);
    expect(clashResult.status).not.toBe(0);
    expect(clashResult.stderr).toContain('不覆寫');
    const inRepo = run(['--out', path.resolve(__dirname, '../../../data/x')]);
    expect(inRepo.status).not.toBe(0);
    expect(inRepo.stderr).toContain('repo');
  });

  it('兩份名冊都是保形匿名 OOXML（inlineStr／無 sharedStrings／無 dimension），manifest 逐列有手算預期與 spec 出處', async () => {
    const out = generate(temp());
    for (const file of ['round4-baseline.xlsx', 'round4-variant.xlsx']) {
      const zip = await JSZip.loadAsync(fs.readFileSync(path.join(out, file)));
      expect(zip.file('xl/sharedStrings.xml'), `${file} 必須是 inlineStr`).toBeNull();
      const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
      expect(xml).toContain('t="inlineStr"');
      expect(xml).not.toContain('<dimension');
    }
    const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.synthetic).toBe(true);
    expect(manifest.students.cases).toBeGreaterThanOrEqual(20);
    expect(manifest.students.baseline).toBeGreaterThanOrEqual(20);
    expect(manifest.students.variant).toBeGreaterThanOrEqual(20);
    for (const item of manifest.cases) {
      expect(item.code, '合成代碼格式').toMatch(/^R4_[A-Z0-9_]+$/);
      expect(item.tests.length, `${item.code} 要寫這列測什麼`).toBeGreaterThan(0);
      expect(item.specRefs.length, `${item.code} 要附 spec 出處`).toBeGreaterThan(0);
      expect(item.acceptance.length, `${item.code} 要對應驗收清單項目`).toBeGreaterThan(0);
      for (const ref of item.acceptance) expect(ref, `${item.code} 的驗收項目要有編號`).toMatch(/§\d|\b[DNUF]\d{2}\b|UX\d{2}/);
      expect(item.baselineRow ?? item.variantRow, `${item.code} 至少一側有名冊列`).toBeTruthy();
      expect(item.expected, `${item.code} 要有手算預期`).toBeTruthy();
    }
    expect(manifest.facetJourney.length, '跨欄 journey 至少 4 步').toBeGreaterThanOrEqual(4);
    for (const step of manifest.facetJourney) {
      expect(step.action, `journey step ${step.step} 要寫操作`).toBeTruthy();
      expect(Number.isInteger(step.resultCount)).toBe(true);
    }
  });
});

describe('T4 manifest 手算預期 vs 產品實際（UI 相同匯入入口；不一致即失敗，不回填 manifest）', () => {
  let manifest: Manifest;
  let product: ProductRun;

  beforeEach(async () => {
    const dir = temp();
    process.env.DATABASE_PATH = path.join(dir, 'app.sqlite');
    if (global.__sqlite_db__) global.__sqlite_db__.close();
    global.__sqlite_db__ = undefined;
    const out = generate(dir);
    manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    product = await productRun(out);
  });

  afterEach(() => {
    global.__sqlite_db__?.close();
    global.__sqlite_db__ = undefined;
    delete process.env.DATABASE_PATH;
  });

  it('兩份名冊解析人數皆等於 manifest 宣告的人數', () => {
    expect(product.baselineCount, 'baseline 人數').toBe(manifest.students.baseline);
    expect(product.variantCount, 'variant 人數').toBe(manifest.students.variant);
  });

  it('報名異動與折扣變動的畫面文字逐案等於 manifest 手算（班名原文）', () => {
    // 報名集合兩側相同、或預期含 status（新學生／已不在名單）的案例，在明細中不列折扣列。
    const hasEnrollmentDiff = (item: CaseEntry) =>
      JSON.stringify(item.baselineRow?.classes ?? null) !== JSON.stringify(item.variantRow?.classes ?? null);
    for (const item of manifest.cases) {
      const actual = product.changes.get(item.code);
      if (typeof item.expected.status !== 'string' && !hasEnrollmentDiff(item)) continue;
      expect(actual, `${item.code} 應出現在逐人明細`).toBeDefined();
      if (typeof item.expected.status === 'string') expect(actual!.status, `${item.code} 狀態`).toBe(item.expected.status);
      if (Array.isArray(item.expected.enrollmentText)) {
        expect(actual!.enrollmentText, `${item.code} 報名異動`).toEqual(item.expected.enrollmentText);
      }
      if (Array.isArray(item.expected.classDiscountText)) {
        // manifest 的空陣列＝資料層沒有任何折扣變動列；UI 對應呈現為單一「—」。
        const want = item.expected.classDiscountText.length ? item.expected.classDiscountText : ['—'];
        expect(actual!.classDiscountText, `${item.code} 折扣變動`).toEqual(want);
      }
    }
  });

  it('各案例計算值（科數／基本率／課程率／天數／問題）逐欄等於 manifest 手算', () => {
    for (const item of manifest.cases) {
      // 已不在名單者不在 variant run 的 student_calculations；其 after 手算不適用，before 手算比 baseline run。
      const row = item.variantRow ? product.rows.get(item.code) : product.baselineRows.get(item.code);
      expect(row, `${item.code} 應有計算結果`).toBeDefined();
      const after = (item.variantRow ? item.expected.after : item.expected.before) as Record<string, unknown> | undefined;
      if (!after) continue;
      for (const [key, column] of Object.entries(COLUMN_OF)) {
        if (key in after) expect(row![column], `${item.code}.after.${key}`).toEqual(after[key]);
      }
      if (Array.isArray(item.expected.issueCodes)) {
        const codes = (JSON.parse(row!.issues as string) as Array<{ code: string }>).map((issue) => issue.code);
        for (const code of item.expected.issueCodes as string[]) expect(codes, `${item.code} 的問題`).toContain(code);
      }
    }
  });

  it('跨欄計數：其他欄條件套用後，本欄候選值會變 0 人、已套用值仍保留（素材 FACET5／FACET6）', () => {
    // 未套條件：年級面板五年級 1（FACET5）、六年級 1（FACET6）。
    expect(product.optionsAll.grades.get('5'), '未套條件：五年級').toBe(1);
    expect(product.optionsAll.grades.get('6'), '未套條件：六年級').toBe(1);
    // 套 grade=5（排除本欄篩選）：年級面板不變；其他欄候選套用後歸 0。
    expect(product.optionsGrade5.grades.get('5'), '套 grade=5：年級面板五年級仍 1（排除本欄篩選）').toBe(1);
    expect(product.optionsGrade5.grades.get('6'), '套 grade=5：年級面板六年級仍 1（排除本欄篩選）').toBe(1);
    expect(product.optionsGrade5.classes.get('國小數學-二A'), '套 grade=5：同年級不同年級的同班候選仍有 1 人（FACET6）').toBe(1);
    expect(product.optionsGrade5.classes.get('國小數學-三A'), '套 grade=5：其他年級的班候選變 0 人（可做出 0 人值）').toBe(0);
    // 套 enrollmentKey=國小數學-二A（wire 用 baseName）：年級面板一年級歸 0，五年級／六年級各 1。
    expect(product.optionsClass2A.grades.get('1'), '套班級 Q：年級面板一年級變 0 人').toBe(0);
    expect(product.optionsClass2A.grades.get('5'), '套班級 Q：年級面板五年級 1').toBe(1);
    expect(product.optionsClass2A.grades.get('6'), '套班級 Q：年級面板六年級 1').toBe(1);
    expect(product.optionsClass2A.sibling.get('true'), '套班級 Q：兄弟姊妹面板 是 1（FACET6）').toBe(1);
    expect(product.optionsClass2A.sibling.get('false'), '套班級 Q：兄弟姊妹面板 否 1（FACET5）').toBe(1);
    // 套 sibling=true：年級面板五年級歸 0，六年級 1。
    expect(product.optionsSiblingTrue.grades.get('5'), '套 sibling=true：年級面板五年級變 0 人').toBe(0);
    expect(product.optionsSiblingTrue.grades.get('6'), '套 sibling=true：年級面板六年級 1').toBe(1);
  });

  it('manifest 使用的折扣短標與畫面短標一致（呈現契約，非 expected）', () => {
    expect(formatDiscountBps(10000)).toBe('無折扣');
    expect(formatDiscountBps(9500)).toBe('95折');
    expect(formatDiscountBps(8500)).toBe('85折');
  });
});