import { test, expect } from '@playwright/test';

test.describe('Home Page Smoke Test', () => {
  test('首頁應展示乾淨空狀態與本地儲存路徑', async ({ page }) => {
    await page.goto('/');

    // 檢查標題
    await expect(page.locator('h1')).toContainText('學生收費核對工具');
    await expect(page.locator('h2')).toContainText('尚未匯入學生收費名單');

    // 檢查資料目錄標示
    await expect(page.locator('.path-box')).toContainText('student-billing/data/');

    // 檢查前往匯入按鈕與導航
    const uploadLink = page.locator('a.btn-primary', { hasText: '前往匯入名單' });
    await expect(uploadLink).toBeVisible();
    await uploadLink.click();

    await expect(page).toHaveURL(/\/imports/);
    await expect(page.locator('h2')).toContainText('上傳 ERP 學生名單');
  });
});
