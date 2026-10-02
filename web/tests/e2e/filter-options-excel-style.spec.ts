import { test, expect, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { openFilter, matchedCount } from './helpers/header-filter';

const CARE = '國小輔導-一A';
const MATH = '國小數學-一A';

/** 完全合成，inlineStr／無 sharedStrings／無 dimension；不讀真實資料。 */
async function workbook(): Promise<Buffer> {
  const rows = [
    ['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註'],
    ['XA', '合成甲', '合成分校', `${CARE}[團][4]\n${MATH}[團]`, '一年級', '', ''],
    ['XB', '合成乙', '合成分校', `${CARE}[團]\n${MATH}[團]`, '一年級', '', ''],
    ['XC', '合成丙', '合成分校', `${MATH}[團]`, '三年級', '', ''],
    ['XD', '合成丁', '合成分校', '', '四年級', '', ''],
    ['XE', '合成戊', '合成分校', `${CARE}[團]`, '二年級', '', ''],
  ];
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const xml = rows.map((row, i) => `<row r="${i + 1}">${row.map((v, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t xml:space="preserve">${escape(v)}</t></is></c>`).join('')}</row>`).join('');
  zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xml}</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function selectClass(page: Page, className: string) {
  const panel = await openFilter(page, '所屬班級');
  await panel.getByRole('button', { name: '取消全選', exact: true }).click();
  await panel.locator(`[data-filter-option="${className}"] input`).check();
  await panel.getByRole('button', { name: '確定', exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  const current = await page.request.get('/api/v1/runs/current');
  const body = await current.json();
  if (!body.activeRunId) {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles({ name: 'excel-options.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await workbook() });
    await page.getByRole('button', { name: '使用這份名單', exact: true }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 20_000 });
  }
  await page.goto('/');
  await expect(page.locator('.results-table')).toBeVisible({ timeout: 20_000 });
});

test('選班後面板計數等於點選人數，統計不一致數依該班範圍', async ({ page }) => {
  // CARE={甲一年級、乙一年級、戊二年級}；只有甲care宣告4、計算5不一致。
  await selectClass(page, CARE);
  await expect(page.locator('[data-count="matched"]')).toHaveText('3');
  const grades = await openFilter(page, '年級');
  await expect(grades.locator('[data-filter-option="1年級"] [data-filter-count]')).toHaveText('2');
  await expect(grades.locator('[data-filter-option="2年級"] [data-filter-count]')).toHaveText('1');
  await expect(grades.locator('[data-filter-option="3年級"]')).toHaveCount(0);
  await grades.locator('[data-filter-option="2年級"] input').check();
  await grades.getByRole('button', { name: '確定', exact: true }).click();
  await expect(page.locator('[data-count="matched"]')).toHaveText('1');
  expect(await matchedCount(page)).toBe(1);
  await page.getByRole('button', { name: '清除全部', exact: true }).click();
  await selectClass(page, MATH);
  // math的甲、乙、丙都不適用care級距，不能計入甲care班的不一致。
  await expect(page.locator('[data-count="matched"]')).toHaveText('3');
  const mismatch = await openFilter(page, '需確認');
  await expect(mismatch.locator('[data-filter-option="天數不同"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('URL 還原已勾選0人值：不prune，仍能取消；未勾選0人值不顯示', async ({ page }) => {
  // 既有0結果畫面不渲染表頭；用OR保留有結果的1年級，同時驗已選但0人的3年級。
  await page.goto(`/?enrollmentKey=${encodeURIComponent(CARE)}&grade=1&grade=3`);
  await expect(page.locator('[data-count="matched"]')).toHaveText('2');
  const grades = await openFilter(page, '年級');
  await expect(grades.locator('[data-filter-option="3年級"] [data-filter-count]')).toHaveText('0');
  await expect(grades.locator('[data-filter-option="3年級"] input')).toBeChecked();
  await expect(grades.locator('[data-filter-option="4年級"]')).toHaveCount(0);
  await grades.locator('[data-filter-option="3年級"] input').uncheck();
  await grades.getByRole('button', { name: '確定', exact: true }).click();
  await expect(page.locator('[data-count="matched"]')).toHaveText('2');
  expect(new URL(page.url()).searchParams.getAll('grade')).toEqual(['1']);
});

test('舊 options 回應延後到新選班後：不能覆蓋新面板計數', async ({ page }) => {
  let releaseOld!: () => void;
  let captured!: () => void;
  let finished!: () => void;
  const delivered = new Promise<void>((resolve) => { finished = resolve; });
  const held = new Promise<void>((resolve) => { releaseOld = resolve; });
  const seen = new Promise<void>((resolve) => { captured = resolve; });
  let oldCaptured = false;
  await page.route('**/api/v1/runs/*/students?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('options') === 'true' && url.searchParams.get('enrollmentKey') === CARE && !oldCaptured) {
      oldCaptured = true;
      const response = await route.fetch();
      captured();
      await held;
      await route.fulfill({ response }).catch(() => { /* 最新request已abort舊request時無須再回覆。 */ });
      finished();
    } else await route.continue();
  });
  try {
    await selectClass(page, CARE);
    await seen;
    await selectClass(page, MATH);
    await expect(page.locator('[data-count="matched"]')).toHaveText('3');
    const grades = await openFilter(page, '年級');
    await expect(grades.locator('[data-filter-option="3年級"] [data-filter-count]')).toHaveText('1');
    await expect(grades.locator('[data-filter-option="2年級"]')).toHaveCount(0);
    releaseOld();
    await delivered;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(grades.locator('[data-filter-option="2年級"]')).toHaveCount(0);
    await expect(grades.locator('[data-filter-option="3年級"] [data-filter-count]')).toHaveText('1');
  } finally { releaseOld(); }
});
