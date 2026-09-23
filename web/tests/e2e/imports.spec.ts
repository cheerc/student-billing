import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('Imports Page E2E Test', () => {
  test('上傳 ERP 試算表後應正確展示統計與名單預覽', async ({ page }) => {
    await page.goto('/imports');

    // 檢查頁面標題
    await expect(page.locator('h2')).toContainText('上傳 ERP 學生名單');

    // 上傳測試用保形匿名 fixture
    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(fixturePath);

    // 驗證預覽統計數據出現：477、384、93
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
  });
});
