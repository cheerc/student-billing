import { test, expect } from '@playwright/test';

test.describe('Home Page Smoke Test', () => {
  test('首頁應正常渲染標題、導航與狀態', async ({ page }) => {
    await page.goto('/');

    // 檢查首頁標題
    await expect(page.locator('h1')).toContainText('學生收費核對工具');

    // 檢查導航連結
    const importsNav = page.locator('nav a[href="/imports"]');
    await expect(importsNav).toBeVisible();

    // 檢查若為初始狀態展示空狀態說明，若已匯入則展示名冊卡片
    const hasStats = (await page.locator('.stats-grid').count()) > 0;
    if (!hasStats) {
      await expect(page.locator('h2')).toContainText('尚未匯入學生收費名單');
      await expect(page.locator('.path-box')).toContainText('student-billing/data/');
    } else {
      await expect(page.locator('.stat-card').first()).toBeVisible();
    }
  });
});
