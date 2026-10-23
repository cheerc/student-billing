import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
import { XLSX_MIME } from './helpers/c-batch';

/**
 * N02／R3-F01（issue #54；specs/04 §8 UX65）：
 * 類別異動影響預覽必須呈現科數與合計折扣之逐人變動明細。
 * 採用 2 位學生之最小合成案例（真實瀏覽器匯入 → 啟用 v3 → 課表僅改類別 → 預覽確認）：
 *   - 學生 1 (R3_001, 五年級)：僅報名「國小國語文-小五」
 *     before: categories=[none] → 科數 0，折扣 10000（無折扣）
 *     （#157：seed 各班的類別是使用者明確指定的值，不再由班名推導；此案例的 before 側
 *      因此與舊制相同。）
 *     after:  categories=[math] → 科數 1，折扣 10000（無折扣）
 *     科數變動: 0 → 1，折扣無變動（不列入合計折扣明細表）
 *   - 學生 2 (R3_002, 五年級)：報名「國小輔導-五年級」「兒童美語-Gino」「國小國語文-小五」
 *     before: categories=[care, english, none] → 科數 2，折扣 9500（95折）
 *     after:  categories=[care, english, math] → 科數 3，折扣 9000（9折）
 *     科數變動: 2 → 3，折扣變動: 95折 → 9折
 *   - 「國小國語文-小五」在 seed 中僅週六 15:00–17:00 有時段，與一至五課輔窗口（16:30–19:30）零重疊。
 *     故兩位學生天數差皆為 0（dayDeltas 為空），受影響人數為 2 人（聯集去重）。
 */

async function buildTwoStudentsWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);
  // 學生 1：僅報國語文小五
  ws.addRow(['R3_001', '合成學生甲', '合成分校', '國小國語文-小五[團]', '五年級', '', '']);
  // 學生 2：報輔導五年級＋美語Gino＋國語文小五
  ws.addRow([
    'R3_002',
    '合成學生乙',
    '合成分校',
    '國小輔導-五年級[團]\n兒童美語-Gino[團]\n國小國語文-小五[團]',
    '五年級',
    '',
    '',
  ]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function buildFiftyFiveStudentsWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);
  for (let i = 1; i <= 55; i++) {
    const code = `STU_55_${String(i).padStart(3, '0')}`;
    const name = `學生${i}`;
    ws.addRow([
      code,
      name,
      '合成分校',
      '國小輔導-五年級[團]\n兒童美語-Gino[團]\n國小國語文-小五[團]',
      '五年級',
      '',
      '',
    ]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test.describe('N02／R3-F01: 類別異動影響預覽科數與合計折扣明細', () => {
  test('只改類別（時段不動，天數差為 0）時，預覽呈現天數未變提示、聯集去重 2 人、科數明細（0→1, 2→3）與折扣明細（95折→9折）', async ({
    page,
  }) => {
    // 1. 匯入並啟用合成名單
    await page.goto('/imports');
    const buffer = await buildTwoStudentsWorkbook();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'round3-n02-fixture.xlsx',
      mimeType: XLSX_MIME,
      buffer,
    });
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    const useBtn = page.locator('button', { hasText: '使用這份名單' });
    await expect(useBtn).toBeVisible({ timeout: 15000 });
    await useBtn.click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });

    // 2. 進入課表設定頁面
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });

    // 確認初始狀態乾淨
    await expect(page.locator('.save-status-clean')).toBeVisible();

    // 3. 把「國小國語文-小五」從「不列入折扣」（none）改為「數學班」（math）
    // #80：同一班多列各有一份屬性下拉 → 收斂到第一列
    const row = page
      .locator('tr.schedule-row', { has: page.locator(`input.input-classname[value="國小國語文-小五"]`) })
      .first();
    await expect(row).toBeVisible();
    await expect(row.locator('[data-category-select="國小國語文-小五"]')).toHaveValue('none');
    await row.locator('[data-category-select="國小國語文-小五"]').selectOption('math');
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    // 4. 開啟儲存確認視窗 (ImpactDialog)
    await page.locator('button', { hasText: '確認變更' }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    // 5. 驗證天數未變前提與受影響人數（聯集去重）
    await expect(dialog.getByText('本次課表變更未改變現行學生的收費天數。')).toBeVisible();
    await expect(dialog.locator('.deltas-table-container', { hasText: '天數變動明細' })).toHaveCount(0);
    const metric = dialog.locator('.metric-card', { hasText: '受影響學生數' });
    await expect(metric.locator('.metric-value')).toHaveText('2 人');

    // 6. 驗證科數變動明細表格
    const subjectTable = dialog.locator('.deltas-table-container', { hasText: '科數變動明細' });
    await expect(subjectTable).toBeVisible();
    const stu1SubjectRow = subjectTable.locator('tr', { hasText: 'R3_001' });
    await expect(stu1SubjectRow).toBeVisible();
    await expect(stu1SubjectRow.locator('td').nth(2)).toHaveText('0');
    await expect(stu1SubjectRow.locator('td').nth(3)).toHaveText('1');

    const stu2SubjectRow = subjectTable.locator('tr', { hasText: 'R3_002' });
    await expect(stu2SubjectRow).toBeVisible();
    await expect(stu2SubjectRow.locator('td').nth(2)).toHaveText('2');
    await expect(stu2SubjectRow.locator('td').nth(3)).toHaveText('3');

    // 7. 驗證合計折扣變動明細表格
    const discountTable = dialog.locator('.deltas-table-container', { hasText: '合計折扣變動明細' });
    await expect(discountTable).toBeVisible();
    // 學生 1 折扣未變（10000 → 10000），不得列入折扣異動明細表
    await expect(discountTable.locator('tr', { hasText: 'R3_001' })).toHaveCount(0);

    // 學生 2 折扣變動（9500 → 9000），顯示為「95折 → 9折」
    const stu2DiscountRow = discountTable.locator('tr', { hasText: 'R3_002' });
    await expect(stu2DiscountRow).toBeVisible();
    await expect(stu2DiscountRow.locator('td').nth(2)).toHaveText('95折');
    await expect(stu2DiscountRow.locator('td').nth(3)).toHaveText('9折');
  });

  test('PR56 N2 follow-up: 768×600 下大量列（55 學生）兩表各 cap 50 且標題明示、可內部捲動、主按鈕可見可點、Tab/Esc 焦點還原', async ({
    page,
  }) => {
    // 0. 設定 768x600 視窗大小
    await page.setViewportSize({ width: 768, height: 600 });

    // 1. 匯入並啟用 55 人合成名單
    await page.goto('/imports');
    const buffer = await buildFiftyFiveStudentsWorkbook();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'round3-55students-fixture.xlsx',
      mimeType: XLSX_MIME,
      buffer,
    });
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    const useBtn = page.locator('button', { hasText: '使用這份名單' });
    await expect(useBtn).toBeVisible({ timeout: 15000 });
    await useBtn.click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });

    // 2. 進入課表設定頁面
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.save-status-clean')).toBeVisible();

    // 3. 修改「國小國語文-小五」為數學班
    // #80：同一班多列各有一份屬性下拉 → 收斂到第一列
    const row = page
      .locator('tr.schedule-row', { has: page.locator(`input.input-classname[value="國小國語文-小五"]`) })
      .first();
    await expect(row).toBeVisible();
    await row.locator('[data-category-select="國小國語文-小五"]').selectOption('math');
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    // 4. 開啟確認視窗
    const openBtn = page.locator('button', { hasText: '確認變更' });
    await openBtn.click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    // 5. 驗證天數未變與受影響人數（55 人）
    await expect(dialog.getByText('本次課表變更未改變現行學生的收費天數。')).toBeVisible();
    const metric = dialog.locator('.metric-card', { hasText: '受影響學生數' });
    await expect(metric.locator('.metric-value')).toHaveText('55 人');

    // 6. 驗證科數變動明細：標題明示（前 50 筆）、表格恰 50 列
    const subjectContainer = dialog.locator('.deltas-table-container', { hasText: '科數變動明細' });
    await expect(subjectContainer).toBeVisible();
    await expect(subjectContainer.locator('h3')).toHaveText('科數變動明細（前 50 筆）');
    const subjectRows = subjectContainer.locator('tbody tr');
    await expect(subjectRows).toHaveCount(50);
    await expect(subjectRows.first().locator('td').nth(2)).toHaveText('2');
    await expect(subjectRows.first().locator('td').nth(3)).toHaveText('3');
    await expect(subjectRows.last().locator('td').nth(2)).toHaveText('2');
    await expect(subjectRows.last().locator('td').nth(3)).toHaveText('3');

    // 7. 驗證合計折扣變動明細：標題明示（前 50 筆）、表格恰 50 列
    const discountContainer = dialog.locator('.deltas-table-container', { hasText: '合計折扣變動明細' });
    await expect(discountContainer).toBeVisible();
    await expect(discountContainer.locator('h3')).toHaveText('合計折扣變動明細（前 50 筆）');
    const discountRows = discountContainer.locator('tbody tr');
    await expect(discountRows).toHaveCount(50);
    await expect(discountRows.first().locator('td').nth(2)).toHaveText('95折');
    await expect(discountRows.first().locator('td').nth(3)).toHaveText('9折');
    await expect(discountRows.last().locator('td').nth(2)).toHaveText('95折');
    await expect(discountRows.last().locator('td').nth(3)).toHaveText('9折');

    // 8. 驗證 768x600 下 .dialogbody 可內部捲動
    const dialogBody = dialog.locator('.dialogbody');
    const scrollInfo = await dialogBody.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
    expect(scrollInfo.scrollHeight).toBeGreaterThan(scrollInfo.clientHeight);
    await dialogBody.evaluate((el) => {
      el.scrollTop = 200;
    });
    const scrollTop = await dialogBody.evaluate((el) => el.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);

    // 9. 驗證主按鈕可見、可點擊且完全在 768x600 視窗內
    const applyBtn = dialog.locator('button.btn-primary', { hasText: '儲存並更新結果' });
    const cancelBtn = dialog.locator('button.btn-secondary', { hasText: '繼續編輯' });
    await expect(applyBtn).toBeVisible();
    await expect(applyBtn).toBeEnabled();
    await expect(cancelBtn).toBeVisible();
    await expect(cancelBtn).toBeEnabled();

    const box = await applyBtn.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(768);
      expect(box.y + box.height).toBeLessThanOrEqual(600);
    }

    // 10. 鍵盤 Tab 導航測試（焦點停留在對話框內部）
    await page.keyboard.press('Tab');
    const focusedInDialog = await dialog.evaluate((d) => d.contains(document.activeElement));
    expect(focusedInDialog).toBe(true);

    // 11. Esc 關閉與焦點還原至「確認變更」按鈕
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(openBtn).toBeFocused();
  });
});
