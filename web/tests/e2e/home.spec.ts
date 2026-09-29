import { test, expect } from '@playwright/test';

/**
 * 首頁冒煙測試。
 *
 * R5 更新（specs/09 §2／§7）：
 *   舊：空狀態斷言 h2「尚未匯入學生收費名單」與 `.path-box` 含 `data/`（畫面顯示本機資料庫路徑）
 *   新：09 §7 明列「DB路徑」不得出現在日常介面 → 改為斷言路徑盒**不存在**、畫面沒有 .sqlite／data/；
 *       09 §2 初始首頁主動作「先確認課表」、次動作「匯入學生」，並實際點擊確認導向正確。
 *   強度只增不減：多了「一個 h1」「主／次動作導向」「不外露資料庫路徑」三項。
 */
test.describe('Home Page Smoke Test', () => {
  test('首頁應正常渲染標題、導航與狀態', async ({ page }) => {
    await page.goto('/');

    // 檢查首頁標題：一頁一個 h1
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).toContainText('學生收費核對工具');

    // 檢查導航連結
    const importsNav = page.locator('nav a[href="/imports"]');
    await expect(importsNav).toBeVisible();

    // 檢查若為初始狀態展示空狀態說明，若已匯入則展示名冊卡片
    const hasStats = (await page.locator('.stats-grid').count()) > 0;
    if (!hasStats) {
      await expect(page.locator('h2')).toContainText('還沒有可核對的學生資料');
      // 09 §2：初始首頁主動作「先確認課表」、次動作「匯入學生」
      const primary = page.locator('main a.btn-primary');
      await expect(primary).toHaveText('先確認課表');
      await expect(primary).toHaveAttribute('href', '/settings?tab=schedule');
      const secondary = page.locator('main a.btn-secondary');
      await expect(secondary).toHaveText('匯入學生');
      await expect(secondary).toHaveAttribute('href', '/imports');
      // 09 §7：DB 路徑不得出現在日常介面
      await expect(page.locator('.path-box')).toHaveCount(0);
      await expect(page.locator('main')).not.toContainText(/\.sqlite|data\//);
      // 主動作實際可用
      await primary.click();
      await expect(page).toHaveURL(/\/settings\?tab=schedule/);
      await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible();
    } else {
      await expect(page.locator('.stat-card').first()).toBeVisible();
    }
  });
});
