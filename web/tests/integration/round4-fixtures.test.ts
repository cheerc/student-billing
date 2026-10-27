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
  facetJourney: JourneyStep[];
}

/** 一個面板的完整可見內容：值 → 人數；checked 表示該值已勾選（已勾選的 0 人值仍顯示）。 */
type Panel = Record<string, { count: number; checked: boolean }>;

interface JourneyStep {
  step: number;
  action: string;
  /** 該步驟要看的欄位（grade／enrollmentKey／sibling） */
  panelField: 'grade' | 'enrollmentKey' | 'sibling';
  /** 該步驟已套用的篩選（wire 值；此欄自身排除不適用於計數，但影響結果人數） */
  applied: Record<string, string | string[]>;
  /** UI 可見面板（未勾選的 0 人值依 UX25 隱藏；已勾選的 0 人值保留） */
  panelCounts: Panel;
  /** 按確定後的結果人數 */
  resultCount: number;
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
  grade: 'grade',
};

async function uploadPreview(file: string) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), path.basename(file));
  const response = await previewPOST(new Request('http://127.0.0.1:3000/api/v1/imports/preview', { method: 'POST', body: form }));
  return { status: response.status, body: (await response.json()) as { previewId: string; issues: string[]; stats: { totalStudents: number }; rosterDiff: { changes: RosterChange[] } } };
}

interface ProductRun {
  runId: string;
  baselineRunId: string;
  variantRunId: string;
  baselineCount: number;
  variantCount: number;
  changes: Map<string, { status: string; enrollmentText: string[]; classDiscountText: string[] }>;
  rows: Map<string, Record<string, unknown>>;
  baselineRows: Map<string, Record<string, unknown>>;
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

  const db = getDatabase();
  const readRows = (id: string) => {
    const map = new Map<string, Record<string, unknown>>();
    for (const row of db.prepare('SELECT * FROM student_calculations WHERE run_id = ?').all(id) as Array<Record<string, unknown>>) {
      map.set(row.person_code as string, row);
    }
    return map;
  };
  const baselineRows = readRows(runId);

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

  const rows = readRows(variantRunId);
  return { runId, baselineRunId: runId, variantRunId, baselineCount: baseline.body.stats.totalStudents, variantCount: variant.body.stats.totalStudents, changes, rows, baselineRows };
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
    let previousStep = 0;
    for (const step of manifest.facetJourney) {
      expect(step.step, 'journey 步驟編號要連續遞增').toBe(previousStep + 1);
      previousStep = step.step;
      expect(step.action, `journey step ${step.step} 要寫操作`).toBeTruthy();
      expect(['grade', 'enrollmentKey', 'sibling'], `step ${step.step} 的面板欄位`).toContain(step.panelField);
      expect(step.panelCounts, `step ${step.step} 要有可見面板`).toBeTruthy();
      for (const [value, entry] of Object.entries(step.panelCounts)) {
        expect(entry, `step ${step.step} 的面板項目格式`).toMatchObject({ count: expect.any(Number), checked: expect.any(Boolean) });
        expect(value.length, `step ${step.step} 的面板值`).toBeGreaterThan(0);
      }
      expect(Number.isInteger(step.resultCount), `step ${step.step} 的結果人數`).toBe(true);
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

  it('各案例計算值逐欄等於 manifest 手算：before／after 全欄位皆被驗證（無頂層遺漏）', () => {
    // manifest 的手算欄位一律放在 expected.before／after；這裡逐一比對兩側，且頂層不允許再出現欄位。
    const SCALAR = COLUMN_OF;
    for (const item of manifest.cases) {
      for (const side of ['before', 'after'] as const) {
        const expected = (item.expected[side] ?? {}) as Record<string, unknown>;
        const run = side === 'after' ? product.rows : product.baselineRows;
        const rosterRow = side === 'after' ? item.variantRow : item.baselineRow;
        if (!rosterRow) continue;
        const row = run.get(item.code);
        expect(row, `${item.code}.${side} 應有計算結果`).toBeDefined();
        for (const [key, value] of Object.entries(expected)) {
          if (key === 'grade') { expect(row!.grade, `${item.code}.${side}.grade`).toBe(value); continue; }
          const column = SCALAR[key];
          expect(column, `${item.code}.${side}.${key} 必須是已知欄位`).toBeTruthy();
          expect(row![column], `${item.code}.${side}.${key}`).toEqual(value);
        }
      }
      for (const key of Object.keys(item.expected)) {
        // siblingHandComputed 為手算註記（產品由 tags_raw 判定，非 student_calculations 欄位），
        // 其正負由 journey step 4 的 sibling 面板逐步驗證；此處只擋掉真正的計算欄位落在頂層。
        expect(['before', 'after', 'status', 'enrollmentText', 'classDiscountText', 'issueCodes', 'enrollmentKeyWire', 'siblingHandComputed'], `${item.code} 頂層欄位 ${key} 應改放 before/after 或屬文案欄`).toContain(key);
        for (const scalar of Object.keys(SCALAR)) {
          expect(Object.keys(item.expected), `${item.code} 頂層不得殘留計算欄位 ${scalar}`).not.toContain(scalar);
        }
      }
      if (Array.isArray(item.expected.issueCodes)) {
        const row = item.variantRow ? product.rows.get(item.code) : product.baselineRows.get(item.code);
        const codes = (JSON.parse(row!.issues as string) as Array<{ code: string }>).map((issue) => issue.code);
        for (const code of item.expected.issueCodes as string[]) expect(codes, `${item.code} 的問題`).toContain(code);
      }
    }
  });

  it('跨欄 journey 每一步的可見面板（含已勾選的 0 人值）與結果人數都等於 manifest 手算', async () => {
    // 依 UX25：未勾選的 0 人值隱藏；已勾選的 0 人值仍顯示。
    const visible = (counts: Map<string, number>, checked: string[]): Panel => {
      const panel: Panel = {};
      for (const [value, count] of counts) {
        if (count === 0 && !checked.includes(value)) continue;
        panel[value] = { count, checked: checked.includes(value) };
      }
      return panel;
    };
    for (const step of manifest.facetJourney) {
      const params: Array<[string, string]> = [['options', 'true'], ...Object.entries(step.applied).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string]))];
      // journey 的手算來自 manifest 的 variant 名冊列，故比對對象是 variant run。
      const response = await runGET(new NextRequest(`http://127.0.0.1:3000/api/v1/runs/${product.variantRunId}/students?${new URLSearchParams(params)}`), { params: Promise.resolve({ runId: product.variantRunId }) });
      expect(response.status, await response.clone().text()).toBe(200);
      const data = (await response.json()) as { totalStudents: number; options: Record<string, Array<{ value: string; count: number }>> };
      const counts = new Map((data.options[step.panelField] ?? []).map((o) => [o.value, o.count]));
      const raw = step.applied[step.panelField];
      const checked = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]);
      expect(visible(counts, checked), `step ${step.step} ${step.panelField} 可見面板`).toEqual(step.panelCounts);
      // 結果人數：套用全部條件（含本欄）後的去重人數。
      const resultParams = Object.entries(step.applied).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string]));
      const resultResponse = await runGET(new NextRequest(`http://127.0.0.1:3000/api/v1/runs/${product.variantRunId}/students?${new URLSearchParams(resultParams)}`), { params: Promise.resolve({ runId: product.variantRunId }) });
      expect(resultResponse.status, await resultResponse.clone().text()).toBe(200);
      expect((await resultResponse.json()).totalStudents, `step ${step.step} 結果人數`).toBe(step.resultCount);
    }
  });

  it('manifest 使用的折扣短標與畫面短標一致（呈現契約，非 expected）', () => {
    expect(formatDiscountBps(10000)).toBe('無折扣');
    expect(formatDiscountBps(9500)).toBe('95折');
    expect(formatDiscountBps(8500)).toBe('85折');
  });
});