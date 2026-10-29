import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import JSZip from 'jszip';

/**
 * specs/09 §4／specs/04 UX11：
 * R3 匯入名單與啟用工作流程 E2E 測試：
 * 選擇檔案（上傳）→ 確認名單（預覽與統計）→ 點擊「使用這份名單」啟用 → 完成並點擊「前往核對結果」導向首頁。
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
    // 無課程（D38／UX29）：零報名人數，附離籍提示；與有報名班級人數互補
    await expect(page.locator('.stat-card', { hasText: '無課程' })).toContainText('93');
    await expect(page.locator('.stat-card', { hasText: '無課程' })).toContainText('請至米豆奶辦理離籍');

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

    // #84：完成畫面精簡——只有導向 03 的主 CTA，沒有「再匯入其他名單」（避免疊加匯入誤解）
    await expect(successCard.locator('a', { hasText: '前往核對結果' })).toHaveCount(1);
    await expect(successCard.locator('button')).toHaveCount(0);
    await expect(successCard).not.toContainText('再匯入其他名單');
    await expect(successCard).toContainText('03 核對結果');

    /**
     * #84：側邊欄「03 核對結果」在匯入成功階段帶柔和靜態高亮，
     * 目的是讓使用者建立 01→02→03 的導覽心智。
     * 這裡斷言的是**跨元件的實際渲染結果**（側邊欄與匯入工作流不是同一個元件樹），
     * 而非 import-success-guide 的純邏輯單元測試。步驟指示器此時已進入第 3 階段，
     * 故以 data-testid 鎖定「03 核對結果」那一列，避免抓到品牌列（品牌也連到 /）。
     */
    const navResults = page.locator('[data-testid="nav-item-results"]');
    await expect(navResults).toHaveClass(/nav-item-highlight/);
    // `.nav-item` transitions all properties; wait for the static halo to finish entering before checking its exact CSS.
    await expect(navResults).toHaveCSS('box-shadow', 'rgba(37, 99, 235, 0.4) 0px 0px 0px 2px');
    // 高亮的是柔和靜態外框，不是動畫（UI/UX Pro Max：Continuous Animation 只用於載入指示器）
    const highlight = await navResults.evaluate((el) => {
      const s = getComputedStyle(el);
      return { shadow: s.boxShadow, name: s.animationName, duration: s.animationDuration };
    });
    // getComputedStyle 會把顏色正規化為 rgba(37, 99, 235, 0.4) 0px 0px 0px 2px
    expect(highlight.shadow).toContain('rgba(37, 99, 235, 0.4)');
    expect(highlight.shadow).toContain('2px');
    expect(highlight.name).toBe('none');

    // 點擊「前往核對結果 →」導向首頁
    const startReviewBtn = successCard.locator('a', { hasText: '前往核對結果' });
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

    // #84：抵達 03 後高亮自動消除（03 本身就是 active 頁，不需要引導），且不復發
    const navResultsOnResults = page.locator('[data-testid="nav-item-results"]');
    await expect(navResultsOnResults).not.toHaveClass(/nav-item-highlight/);
    await expect(navResultsOnResults).toHaveClass(/active/);
    await page.goto('/imports');
    await expect(page.locator('[data-testid="nav-item-results"]')).not.toHaveClass(/nav-item-highlight/);
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
    // PR-2：「報名異動」改為實際明細欄位，不再禁止欄位名稱。
    await expect(page.locator('.roster-changes-table thead th', { hasText: '報名異動' })).toHaveCount(1);

    // 逐人明細（折疊區，展開後可見）：三位學生各自歸類，異動者顯示折扣 無折扣 → 95折
    const details = page.locator('.roster-changes-details');
    await expect(details).toBeVisible();
    await details.locator('summary').click();
    const table = details.locator('.roster-changes-table');
    await expect(table.locator('tbody tr[data-status="changed"]')).toHaveCount(1);
    await expect(table.locator('tbody tr[data-status="new"]')).toHaveCount(1);
    await expect(table.locator('tbody tr[data-status="not-appeared"]')).toHaveCount(1);

    // 預期班名取自 buildVariantFixture 寫入的名冊原文 token「115國小數學-三A[團]」（第 31 列），
    // 依 decision d-20261003090015932342-4 逐人明細顯示原文；不由產品輸出回填。
    const changedRow = table.locator('tbody tr[data-status="changed"]');
    await expect(changedRow).toContainText('STU0001');
    await expect(changedRow.locator('[data-field="enrollment"]')).toHaveText('新增 115國小數學-三A[團]');
    await expect(changedRow.locator('[data-field="class-discount"] .roster-change-discount-values')).toHaveText('無折扣 → 95折');
    await expect(changedRow.locator('[data-field="class-discount"] [data-reason]')).toHaveText('新增 115國小數學-三A[團]');
    await expect(table.locator('tbody tr[data-status="new"]')).toContainText('STU9999');
    await expect(table.locator('tbody tr[data-status="not-appeared"]')).toContainText('STU0477');
  });

  test('匯入預覽只顯示單一班名同步摘要，N/M/K 與課表 badge 對齊', async ({ page }) => {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
    const summary = page.getByRole('region', { name: '班名同步摘要' });
    await expect(summary).toBeVisible({ timeout: 15000 });

    /**
     * 獨立合成 fixture 盤點（不讀 `getClassNameMatchReport`／summary API 的輸出作 expected）：
     * `conforming-erp-fixture.xlsx` 第 2–478 列共 477 位；逐列將「所屬班級」欄依換行拆成報名，
     * 依 token 語法取 base name，再與 fresh seed 的 49 個班名做完全相同字串比對。fresh seed 無 alias：
     * 54 個不同名冊班名中 42 個完全同名、12 個不一致；12 個皆未對應；含任一不一致班名的不同人員代碼 191 位。
     * 對應規則手算：N=54−42=12，M=12（alias 集合空），K=符合上述 roster-row predicate 的 distinct personCode=191。
     */
    await expect(summary).toContainText('名冊有 12 個班名與課表不一致（其中 12 個尚未對應，影響 191 位學生）');
    await expect(summary.getByRole('link', { name: '前往班名同步 →' })).toHaveAttribute(
      'href',
      /^\/settings\?tab=sync&import=.+/
    );
    await expect(page.locator('.class-name-report-summary')).toHaveCount(1);
    await expect(page.getByText(/本次匯入名冊中發現 .*個班名待確認/)).toHaveCount(0);

    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });

    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
    // fresh seed 沒有 alias，預覽的 12 個 mismatch 等於班名同步 badge 的差異列數。
    const pillText = await page.locator('button[role="tab"]', { hasText: '班名同步' }).locator('.pill.warn').innerText();
    expect(Number(pillText), '課表設定的班名同步頁籤應顯示 12 個不一致班名').toBe(12);
  });
});
