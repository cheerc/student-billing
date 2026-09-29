import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import JSZip from 'jszip';

/**
 * specs/09 §4／specs/04 UX11：
 * R3 匯入名單與啟用工作流程 E2E 測試：
 * 選擇檔案（上傳）→ 確認名單（預覽與統計）→ 點擊「使用這份名單」啟用 → 完成並點擊「開始核對」導向首頁。
 */

/**
 * 由 conforming fixture 衍生「第二份名單」（仍是保形匿名資料，只在記憶體內改，不寫檔）：
 *   - 異動：STU0001（第 2 列）多報一門國小數學 → 科數 1→2，基本折扣 無折扣→95折
 *   - 未出現：刪除最後一列 STU0477
 *   - 新增：複製第 2 列為新人員代碼 STU9999
 * 這是 Reviewer B1（PR #32）要求「使用者在匯入預覽看得到異動」的瀏覽器端實證。
 */
async function buildVariantFixture(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx')));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  let xml = await zip.file(sheetPath)!.async('string');

  const rows = xml.match(/<row [^>]*>[\s\S]*?<\/row>/g)!;
  const row2 = rows[1]; // STU0001
  const lastRow = rows[rows.length - 1]; // STU0477
  expect(row2).toContain('STU0001');
  expect(lastRow).toContain('STU0477');

  // 異動：STU0001 的所屬班級多一門國小數學
  const changedRow2 = row2.replace('兒童美語-KC[團]', '兒童美語-KC[團]\n115國小數學-三A[團]');
  expect(changedRow2).not.toBe(row2);
  xml = xml.replace(row2, changedRow2);

  // 新增：複製第 2 列為 STU9999（列號與儲存格座標改為 479）
  const newRow = changedRow2.replace(/r="(\w)2"/g, 'r="$1479"').replace(/<row\s+r="2"/, '<row r="479"').replace('STU0001', 'STU9999');
  // 未出現：刪除 STU0477，並接上新增的一列
  xml = xml.replace(lastRow, newRow);

  zip.file(sheetPath, xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test.describe('Imports Page E2E Test (R3 匯入頁一次完成使用名單)', () => {
  test('上傳 ERP 試算表 → 預覽統計與名單 → 使用這份名單啟用 → 完成並導向核對結果', async ({ page }) => {
    await page.goto('/imports');

    // 檢查頁面標題與三步驟標示
    await expect(page.locator('h1')).toContainText('匯入學生');
    await expect(page.locator('.step-item.step-active')).toContainText(/1\s*選擇檔案/);
    await expect(page.locator('.step-item.step-active .step-text')).toHaveText('選擇檔案'); // 文字不重複序號
    await expect(page.locator('.schedule-meta-note')).toBeVisible();

    // 檢查上傳標題（去技術化文案）
    await expect(page.locator('h2')).toContainText('上傳米豆奶匯出的學生Excel');

    // 上傳測試用保形匿名 fixture
    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(fixturePath);

    // 驗證進入預覽步驟 (確認名單)，預覽統計數據出現：477、384、93
    await expect(page.locator('.step-item.step-active')).toContainText(/2\s*確認名單/);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.stat-card', { hasText: '學生總人數' })).toContainText('477');
    await expect(page.locator('.stat-card', { hasText: '有報名班級人數' })).toContainText('384');
    await expect(page.locator('.stat-card', { hasText: '無班級人數' })).toContainText('93');

    // 驗證表格資料渲染
    const table = page.locator('.data-table');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(100); // 前 100 筆預覽

    // 驗證搜尋功能
    const searchInput = page.locator('input[placeholder*="搜尋"]');
    await searchInput.fill('STU0001');
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table.locator('tbody tr')).toContainText('STU0001');

    // 驗證核對基準日欄位存在
    const asOfDateInput = page.locator('input[type="date"]');
    await expect(asOfDateInput).toBeVisible();

    // 點擊「使用這份名單」直接在頁內完成啟用 (R3 核心閉環)
    const useBtn = page.locator('button', { hasText: '使用這份名單' });
    await expect(useBtn).toBeVisible();
    await useBtn.click();

    // 驗證進入完成步驟 (Success)
    await expect(page.locator('.step-item.step-active')).toContainText(/3\s*完成/);
    const successCard = page.locator('.success-stage-card');
    await expect(successCard).toBeVisible({ timeout: 15000 });
    await expect(successCard).toContainText('477 位學生資料已備妥');

    // 點擊「開始核對 →」導向首頁
    const startReviewBtn = successCard.locator('a', { hasText: '開始核對' });
    await expect(startReviewBtn).toBeVisible();
    await startReviewBtn.click();

    // 首頁應切換為「目前使用的資料」狀態（R5 文案：不再稱「已啟用正式計算 Run」）
    await expect(page).toHaveURL('/');
    const banner = page.locator('.data-banner-current', { hasText: '目前使用的資料' });
    await expect(banner).toBeVisible({ timeout: 15000 });
    // 來源清楚（09 §2）：檔名、資料更新時間、核對基準日；日常橫幅不出現 Run／rev／長 ID
    await expect(banner).toContainText('conforming-erp-fixture.xlsx');
    await expect(banner).toContainText('資料更新於');
    await expect(banner).toContainText('核對基準日');
    await expect(banner).not.toContainText(/Run|rev/);
    await expect(page.locator('h1')).toHaveText('核對結果');
  });

  /**
   * B1（PR #32）：異動要在匯入預覽**看得到**。用 fixture 啟用成現行名單後，上傳第二份不同的名單，
   * 預覽必須顯示新增／異動／未出現三個數字與逐人明細（折扣 before → after）。
   */
  test('第二份名單預覽：顯示新增／異動／未出現三個數字與逐人明細（B1）', async ({ page }) => {
    // 前置：確保 fixture 已是現行名單（本檔共用同一個隔離 DB；重傳同檔會走判重路徑，故只在尚無 active 時建立）
    await page.goto('/');
    if ((await page.locator('.data-banner-current', { hasText: '目前使用的資料' }).count()) === 0) {
      await page.goto('/imports');
      await page
        .locator('input[type="file"]')
        .setInputFiles(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
      await page.locator('button', { hasText: '使用這份名單' }).click();
      await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });
    }

    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'variant.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: await buildVariantFixture(),
    });
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    // 三個數字（來自 API 的 before/after 計算結果）
    const bar = page.locator('.roster-diff-bar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('[data-diff="new"] strong')).toHaveText('1');
    await expect(bar.locator('[data-diff="changed"] strong')).toHaveText('1');
    await expect(bar.locator('[data-diff="not-appeared"] strong')).toHaveText('1');
    // 不留未兌現的承諾
    await expect(page.locator('text=將於核對結果頁逐位列出')).toHaveCount(0);
    await expect(page.locator('text=報名異動')).toHaveCount(0);

    // 逐人明細（折疊區，展開後可見）：三位學生各自歸類，異動者顯示折扣 無折扣 → 95折
    const details = page.locator('.roster-changes-details');
    await expect(details).toBeVisible();
    await details.locator('summary').click();
    const table = details.locator('.roster-changes-table');
    await expect(table.locator('tbody tr[data-category="changed"]')).toHaveCount(1);
    await expect(table.locator('tbody tr[data-category="new"]')).toHaveCount(1);
    await expect(table.locator('tbody tr[data-category="not-appeared"]')).toHaveCount(1);

    const changedRow = table.locator('tbody tr[data-category="changed"]');
    await expect(changedRow).toContainText('STU0001');
    await expect(changedRow.locator('[data-field="discount"]')).toHaveText('無折扣 → 95折');
    await expect(table.locator('tbody tr[data-category="new"]')).toContainText('STU9999');
    await expect(table.locator('tbody tr[data-category="not-appeared"]')).toContainText('STU0477');
  });

  test('跨頁一致：匯入預覽的「N 個班名待確認」＝課表設定「班名對應」頁籤的待確認數（同一份名單兩頁數字不得不同）', async ({ page }) => {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
    const notice = page.locator('text=/個班名待確認/').first();
    await expect(notice).toBeVisible({ timeout: 15000 });
    const shown = Number(/(\d+)\s*個班名待確認/.exec((await notice.innerText()) ?? '')?.[1]);
    expect(Number.isInteger(shown) && shown > 0, '預覽應顯示大於 0 的待確認班名數').toBe(true);

    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });

    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
    const pillText = await page.locator('button[role="tab"]', { hasText: '班名對應' }).locator('.pill.warn').innerText();
    expect(Number(pillText), '課表設定的班名對應頁籤應顯示待確認數').toBe(shown);
  });
});
