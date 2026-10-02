import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import { XLSX_MIME } from './helpers/c-batch';

/** 全合成名單；保留米豆奶 OOXML 原形：inlineStr、無 sharedStrings、無 dimension。 */
async function workbook(variant: boolean): Promise<Buffer> {
  const math = '國小數學-三A[團]';
  const english = '兒童美語-EA[團]';
  const care = '國小輔導-一A[團]';
  const rows = [
    ['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註'],
    ['ADD', '合成加報', '合成分校', variant ? `${english}\n${math}` : english, '小三', '', ''],
    ['EXIT', '合成退出', '合成分校', variant ? `${math}\n交通車[團]` : `${math}\n${english}`, '小三', '', ''],
    ['SWITCH', '合成換班', '合成分校', variant ? '國小數學-三B[團]' : math, '小三', '', ''],
    ['HOMEWORK', '合成寫功課', '合成分校', `${math}\n${english}${variant ? '\n國小輔導-寫功課[團]' : ''}`, '小三', '', ''],
    ['SIBLING', '合成兄弟姊妹', '合成分校', math, '小三', variant ? '有兄弟姊妹折扣' : '', ''],
    ['GARDEN', '合成園內生', '合成分校', `${care}\n國小數學-一A[團]`, '小一', variant ? '園內生' : '', ''],
    [variant ? 'NEW' : 'GONE', variant ? '合成新學生' : '合成離開生', '合成分校', english, '小三', '', ''],
  ];
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  const sheetRows = rows.map((row, index) => `<row r="${index + 1}">${row.map((value, column) => `<c r="${String.fromCharCode(65 + column)}${index + 1}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`).join('')}</row>`).join('');
  const xml = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  zip.file('xl/worksheets/sheet1.xml', xml);
  expect(xml).not.toContain('<dimension');
  expect(zip.file('xl/sharedStrings.xml')).toBeNull();
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** expected 依 R03／R10／R13 獨立手算；不引用待測計算函式或回填頁面輸出。 */
test('逐人明細：真入口匯入、啟用、第二份預覽與八種異動情境', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto('/imports');
  await page.locator('input[type="file"]').setInputFiles({ name: 'baseline.xlsx', mimeType: XLSX_MIME, buffer: await workbook(false) });
  await expect(page.getByRole('button', { name: '使用這份名單', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '使用這份名單', exact: true }).click();
  await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 20_000 });
  await page.goto('/imports');
  await page.locator('input[type="file"]').setInputFiles({ name: 'variant.xlsx', mimeType: XLSX_MIME, buffer: await workbook(true) });
  await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 20_000 });
  const details = page.locator('.roster-changes-details');
  await details.locator('summary').click();
  const table = details.locator('.roster-changes-table');
  await expect(table.locator('thead th')).toHaveText(['學生', '狀態', '報名異動', '折扣變動', '安親天數', '課輔天數']);
  for (const banned of ['合計折扣', '適用率', '科數', '類別']) await expect(details).not.toContainText(banned);
  const row = (code: string) => table.locator('tbody tr[data-status]').filter({ has: page.locator('.roster-change-code', { hasText: new RegExp(`^${code}$`) }) });
  const enrollment = (code: string) => row(code).locator('[data-field="enrollment"]');
  const discounts = (code: string) => row(code).locator('[data-field="class-discount"] li');

  // 加報：英文一科 → 加數學兩科；只有兩側都報名的英文列 10000 → 9500。
  await expect(enrollment('ADD')).toHaveText('新增 國小數學-三A');
  await expect(discounts('ADD')).toHaveCount(1);
  await expect(discounts('ADD').locator('.roster-change-class-name')).toHaveText('兒童美語-EA');
  await expect(discounts('ADD').locator('.roster-change-discount-values')).toHaveText('無折扣 → 95折');
  await expect(discounts('ADD').locator('[data-reason]')).toHaveText('新增 國小數學-三A');

  // 退出：數學＋英文兩科 → 數學一科，保留的數學 9500 → 10000；交通車不計。
  await expect(enrollment('EXIT')).toContainText('退出 兒童美語-EA');
  await expect(enrollment('EXIT')).toContainText('新增 交通車');
  await expect(discounts('EXIT')).toHaveCount(1);
  await expect(discounts('EXIT').locator('.roster-change-discount-values')).toHaveText('95折 → 無折扣');
  await expect(discounts('EXIT').locator('[data-reason]')).toHaveText('退出 兒童美語-EA');

  await expect(enrollment('SWITCH')).toHaveText('換班 國小數學-三A → 國小數學-三B');
  await expect(enrollment('SWITCH').locator('li')).toHaveCount(1);
  await expect(row('SWITCH').locator('[data-field="class-discount"]')).toHaveText('—');
  // 寫功課不計多科：math＋english 仍兩科 9500；沒有輔導班可發生 care 折扣變動。
  await expect(enrollment('HOMEWORK')).toHaveText('新增 國小輔導-寫功課');
  await expect(row('HOMEWORK').locator('[data-field="class-discount"]')).toHaveText('—');

  // 一科＋兄弟姊妹：effectiveCount 1 → 2，數學 10000 → 9500。
  await expect(discounts('SIBLING')).toHaveCount(1);
  await expect(discounts('SIBLING').locator('.roster-change-discount-values')).toHaveText('無折扣 → 95折');
  await expect(discounts('SIBLING').locator('[data-reason]')).toHaveText('加上標籤「有兄弟姊妹折扣」');
  // 一年級 care＋math 兩科；園內生使安親 max(9000, 9500−500)=9000，math 不變。
  await expect(discounts('GARDEN')).toHaveCount(1);
  await expect(discounts('GARDEN').locator('.roster-change-class-name')).toHaveText('國小輔導-一A');
  await expect(discounts('GARDEN').locator('.roster-change-discount-values')).toHaveText('95折 → 9折');
  await expect(discounts('GARDEN').locator('[data-reason]')).toHaveText('加上標籤「園內生」');
  for (const reason of await table.locator('[data-reason]').all()) await expect(reason).not.toContainText('交通車');
  for (const [code, status] of [['NEW', '新學生'], ['GONE', '已不在名單']]) {
    await expect(row(code).locator('[data-field="status"]')).toHaveText(status);
    await expect(enrollment(code)).toHaveText('—');
    await expect(row(code).locator('[data-field="class-discount"]')).toHaveText('—');
  }
  for (const width of [1280, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    await details.scrollIntoViewIfNeeded();
    const screenshot = testInfo.outputPath(`roster-details-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`逐人明細 ${width}`, { path: screenshot, contentType: 'image/png' });
  }
});
