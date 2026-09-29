import { test, expect } from '@playwright/test';
import path from 'path';

/**
 * specs/09 §4／specs/04 UX11：
 * R3 匯入名單與啟用工作流程 E2E 測試：
 * 選擇檔案（上傳）→ 確認名單（預覽與統計）→ 點擊「使用這份名單」啟用 → 完成並點擊「開始核對」導向首頁。
 */
test.describe('Imports Page E2E Test (R3 匯入頁一次完成使用名單)', () => {
  test('上傳 ERP 試算表 → 預覽統計與名單 → 使用這份名單啟用 → 完成並導向核對結果', async ({ page }) => {
    await page.goto('/imports');

    // 檢查頁面標題與三步驟標示
    await expect(page.locator('h1')).toContainText('匯入學生');
    await expect(page.locator('.step-indicator')).toContainText('1 選擇檔案');
    await expect(page.locator('.schedule-meta-note')).toBeVisible();

    // 檢查上傳標題（去技術化文案）
    await expect(page.locator('h2')).toContainText('上傳ERP匯出的學生Excel');

    // 上傳測試用保形匿名 fixture
    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(fixturePath);

    // 驗證進入預覽步驟 (確認名單)，預覽統計數據出現：477、384、93
    await expect(page.locator('.step-item.step-active')).toContainText('2 確認名單');
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
    await expect(page.locator('.step-item.step-active')).toContainText('3 完成');
    const successCard = page.locator('.success-stage-card');
    await expect(successCard).toBeVisible({ timeout: 15000 });
    await expect(successCard).toContainText('477 位學生資料已備妥');

    // 點擊「開始核對 →」導向首頁
    const startReviewBtn = successCard.locator('a', { hasText: '開始核對' });
    await expect(startReviewBtn).toBeVisible();
    await startReviewBtn.click();

    // 首頁應切換為已啟用正式計算 Run 狀態
    await expect(page).toHaveURL('/');
    await expect(page.locator('text=已啟用正式計算 Run')).toBeVisible({ timeout: 15000 });
  });
});
