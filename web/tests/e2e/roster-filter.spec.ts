import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('名冊篩選 E2E 驗收測試', () => {
  test('上傳米豆奶試算表 → 首頁持久化展示 → 班級與條件篩選 → 重新整理依然存在', async ({ page }) => {
    // 1. 全新未啟用前，首頁顯示乾淨空狀態卡片
    await page.goto('/');
    await expect(page.locator('h2', { hasText: '還沒有可核對的學生資料' })).toBeVisible();

    // 2. 進入匯入頁面
    // R3：匯入頁文案去技術化（specs/09 §4），標題改為「上傳米豆奶匯出的學生Excel」
    await page.goto('/imports');
    await expect(page.locator('h1')).toContainText('匯入學生');
    await expect(page.locator('h2')).toContainText('上傳米豆奶匯出的學生Excel');

    // 3. 上傳測試用保形匿名 fixture
    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(fixturePath);

    // 等待解析完成並呈現統計
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.stat-card', { hasText: '學生總人數' })).toContainText('477');

    // 4. 啟用名單並前往核對結果
    await expect(page.locator('button', { hasText: '使用這份名單' })).toBeVisible({ timeout: 15000 });
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await page.locator('a', { hasText: '前往核對結果' }).click();

    // 5. 首頁應展示已啟用狀態列與統計
    await expect(page.locator('.data-banner-current')).toBeVisible({ timeout: 15000 });
    const counts = page.locator('.counts-line');
    await expect(counts).toBeVisible();
    await expect(counts).toContainText('全部 477 人');

    // 6. 搜尋學生
    const searchInput = page.locator('input[placeholder*="搜尋"]').first();
    await searchInput.fill('STU0001');
    const table = page.locator('.results-table');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table.locator('tbody tr')).toContainText('學生001');

    // 7. 重新整理頁面，驗證持久化仍在
    await page.reload();
    await expect(page.locator('.data-banner-current')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.counts-line')).toContainText('全部 477 人');
  });
});
