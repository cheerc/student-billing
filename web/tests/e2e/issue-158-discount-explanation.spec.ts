import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import { XLSX_MIME } from './helpers/c-batch';

const SYNTHETIC_TAGS = '有兄弟姊妹折扣, 特殊折扣85折, 園內生';

/** 合成名冊；保留來源 OOXML 形狀，只含匿名、人工設定的測試值。 */
async function workbook(): Promise<Buffer> {
  const rows = [
    ['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註'],
    [
      'SYNTH158',
      '合成折扣說明生',
      '合成分校',
      '國小數學-三A[團]\n兒童美語-EA[團]',
      '小三',
      SYNTHETIC_TAGS,
      '',
    ],
  ];
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  const sheetRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => `<c r="${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`).join('')}</row>`).join('');
  zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('Issue #158：本次 Run 明細說明折扣因素、安親差異與保存結果', async ({ page }) => {
  await page.goto('/imports');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'issue-158-synthetic.xlsx',
    mimeType: XLSX_MIME,
    buffer: await workbook(),
  });
  await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '使用這份名單', exact: true }).click();
  await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 20_000 });

  await page.goto('/');
  const table = page.locator('.results-table');
  const trigger = page.locator('[data-student-trigger="SYNTH158"]');
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await trigger.focus();
  await trigger.press('Enter');

  const drawer = page.getByRole('dialog');
  const explanation = drawer.locator('[data-discount-explanation]');
  await expect(drawer).toBeVisible();
  await expect(explanation).toContainText('2 + 1 = 3 科');
  await expect(explanation).toContainText('特殊折扣85折');
  await expect(explanation).toContainText('優先採用');
  await expect(explanation).toContainText('僅調整安親');
  await expect(explanation).toContainText('最低收費率為 9 折');
  // 手算：2 科＋兄弟姊妹 +1 原本為 9 折級距，但特殊 85 折優先；園內生安親最低收費率為 9 折。
  await expect(explanation).toContainText('基本折扣率：');
  await expect(explanation).toContainText('85折');
  await expect(explanation).toContainText('安親: 9折');
  await expect(explanation).toContainText('課輔: 85折');
  await expect(explanation).toContainText('美語: 85折');
  await expect(explanation).toContainText('數學: 85折');
  await expect(explanation).not.toContainText(SYNTHETIC_TAGS);
  await expect(explanation).not.toContainText('bps');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(explanation).toBeVisible();
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox?.width).toBeLessThanOrEqual(390);

  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // 原始標籤全文仍留在既有摺疊區，新增推導區只顯示命中短語。
  await trigger.press('Enter');
  await drawer.locator('summary', { hasText: '原始資料' }).click();
  await expect(drawer).toContainText(SYNTHETIC_TAGS);
  await expect(table).toBeVisible();
});
