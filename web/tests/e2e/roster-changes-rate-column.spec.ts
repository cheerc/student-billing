import { test, expect } from '@playwright/test';
import path from 'path';
import ExcelJS from 'exceljs';
import { activateFixture, XLSX_MIME } from './helpers/c-batch';

/**
 * specs/04 §8 UX78：匯入預覽的逐人明細「適用率」欄（安親／課輔適用率 before → after）。
 *
 * 真實匯入路徑：先以 conforming fixture 啟用成現行名單，再上傳由它衍生的第二份名單（只在記憶體內改，
 * 仍是保形匿名資料）。四種情境各取一位學生，expected 皆為獨立手算（02 §8 R10／R13／R14），不由頁面輸出回填：
 *
 *   STU0010（小一；國小輔導＋交通車＋國小數學，無標籤）→ 加「園內生」標籤  【只適用率變】
 *     科數 2（輔導、數學；交通車不列入）→ 基本 9500 不變；課輔天數／安親天數不變。
 *     安親 R13 園內生：max(9000, 9500 − 500 = 9000) = 9000（前：9500）；課輔 R14 不扣 → 9500 不變。
 *     → 折扣欄「—」；適用率欄只有一行「安親 95折 → 9折」。
 *   STU0001（兒童美語-KC）→ 加報國小數學-三A  【折扣與適用率同時變】
 *     科數 1 → 2，基本 10000 → 9500；無園內生、無寫功課 → 兩項適用率都等於基本率。
 *     → 折扣欄「無折扣 → 95折」；適用率欄兩行「安親 無折扣 → 95折」「課輔 無折扣 → 95折」。
 *   STU0006（小一；兒童美語-EA）→ 清空所屬班級  【一側 null】
 *     前：科數 1、基本 10000，兩項適用率 10000；後：沒有任何報名 → 科數 null → 基本 null → 兩項適用率 null。
 *     → 適用率欄「安親 無折扣 → —」「課輔 無折扣 → —」（null 側是「—」，不是「未設定」）。
 *   STU9999（新增）與 STU0477（未出現） → 不是「異動」，適用率欄「—」。
 */

async function buildVariant(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
  const ws = wb.worksheets[0];
  const COL = { classes: 2, code: 7, tags: 8 };
  const rowOf = (code: string) => {
    let found: ExcelJS.Row | null = null;
    ws.eachRow((row) => {
      if (String(row.getCell(COL.code).value) === code) found = row;
    });
    if (!found) throw new Error(`fixture 找不到 ${code}`);
    return found as ExcelJS.Row;
  };

  // STU0010：只適用率變（加園內生標籤）
  rowOf('STU0010').getCell(COL.tags).value = '園內生';
  // STU0001：折扣與適用率同時變（多報一門國小數學）
  const stu1 = rowOf('STU0001');
  stu1.getCell(COL.classes).value = `${String(stu1.getCell(COL.classes).value)}\n115國小數學-三A[團]`;
  // STU0006：一側 null（清空所屬班級）
  rowOf('STU0006').getCell(COL.classes).value = null;
  // 新增 STU9999：複製 STU0001 的列；未出現：刪掉最後一列 STU0477
  const copy = stu1.values as ExcelJS.CellValue[];
  const lastRowNumber = ws.rowCount;
  expect(String(ws.getRow(lastRowNumber).getCell(COL.code).value)).toBe('STU0477');
  ws.spliceRows(lastRowNumber, 1);
  const added = ws.addRow(copy.slice(1));
  added.getCell(COL.code).value = 'STU9999';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test.describe('UX78 異動明細「適用率」欄（真實匯入路徑）', () => {
  test('四種情境：只適用率變／折扣與適用率同時變／一側 null／新增與未出現', async ({ page }) => {
    await activateFixture(page);

    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles({ name: 'variant-rates.xlsx', mimeType: XLSX_MIME, buffer: await buildVariant() });
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    const bar = page.locator('.roster-diff-bar');
    await expect(bar.locator('[data-diff="changed"] strong')).toHaveText('3');
    await expect(bar.locator('[data-diff="new"] strong')).toHaveText('1');
    await expect(bar.locator('[data-diff="not-appeared"] strong')).toHaveText('1');

    const details = page.locator('.roster-changes-details');
    await details.locator('summary').click();
    const table = details.locator('.roster-changes-table');
    await expect(table.locator('thead th', { hasText: '適用率' })).toHaveCount(1);
    const row = (code: string) => table.locator('tbody tr[data-category]', { hasText: code });
    const lines = (code: string) => row(code).locator('[data-field="rate"] [data-rate]');

    // 只適用率變：折扣欄「—」，適用率欄只有安親一行
    await expect(row('STU0010').locator('[data-field="discount"]')).toHaveText('—');
    await expect(lines('STU0010')).toHaveCount(1);
    await expect(row('STU0010').locator('[data-rate="anqin"]')).toHaveText('安親 95折 → 9折');

    // 折扣與適用率同時變：折扣欄與兩項適用率都顯示
    await expect(row('STU0001').locator('[data-field="discount"]')).toHaveText('無折扣 → 95折');
    await expect(lines('STU0001')).toHaveCount(2);
    await expect(row('STU0001').locator('[data-rate="anqin"]')).toHaveText('安親 無折扣 → 95折');
    await expect(row('STU0001').locator('[data-rate="tutoring"]')).toHaveText('課輔 無折扣 → 95折');

    // 一側 null：「—」，不是「未設定」
    await expect(lines('STU0006')).toHaveCount(2);
    await expect(row('STU0006').locator('[data-rate="anqin"]')).toHaveText('安親 無折扣 → —');
    await expect(row('STU0006').locator('[data-rate="tutoring"]')).toHaveText('課輔 無折扣 → —');
    await expect(row('STU0006')).not.toContainText('未設定');

    // 新增／未出現：不是異動，適用率欄「—」
    await expect(row('STU9999').locator('[data-field="rate"]')).toHaveText('—');
    await expect(row('STU0477').locator('[data-field="rate"]')).toHaveText('—');
  });
});
