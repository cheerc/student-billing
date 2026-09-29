import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('核對結果頁 E2E 驗收測試', () => {
  test('上傳 → 啟用正式 Run → 核對總表八欄 → 篩選 5 筆差異 → 展開明細 Drawer', async ({ page }) => {
    // 1. 上傳 ERP 試算表
    await page.goto('/imports');
    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(fixturePath);

    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    // 2. 返回首頁
    await page.goto('/');

    // 3. 點擊啟用為正式 Run
    const activateBtn = page.locator('button', { hasText: '啟用為正式 Run' });
    if (await activateBtn.isVisible()) {
      await activateBtn.click();
    }

    // 4. 首頁應切換為正式 Run 狀態
    // R3：日常介面去除「展示A/B」技術字與長 ID（specs/09 §7），版本識別收納於技術資訊摺疊區
    await expect(page.locator('text=已啟用正式計算 Run')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=展示B')).toHaveCount(0);
    await expect(page.locator('summary', { hasText: '技術資訊' })).toBeVisible();
    await expect(page.locator('text=核對基準日')).toBeVisible();

    // 驗證八欄標頭
    const table = page.locator('.data-table');
    await expect(table.locator('th', { hasText: '安親天數' })).toBeVisible();
    await expect(table.locator('th', { hasText: '課輔天數' })).toBeVisible();
    await expect(table.locator('th', { hasText: '美語天數' })).toBeVisible();
    await expect(table.locator('th', { hasText: '數學天數' })).toBeVisible();

    // 5. 篩選 5 筆級距差異 (tierMismatch=true)
    const mismatchSelect = page.locator('select', { has: page.locator('option', { hasText: '全部級距狀態' }) });
    await mismatchSelect.selectOption({ label: '⚠ 僅顯示級距差異 (5筆)' });

    // 表格恰好顯示 5 筆
    await expect(table.locator('tbody tr')).toHaveCount(5);
    await expect(table.locator('tbody tr').first()).toContainText('級距差異');

    // 6. 點擊第一筆學生展開明細 Drawer
    await table.locator('tbody tr').first().click();
    const drawer = page.locator('h3', { hasText: 'STU' });
    await expect(drawer).toBeVisible();
    await expect(page.locator('text=八項每週收費天數結果')).toBeVisible();
    await expect(page.locator('text=ERP 登記級距比對清單')).toBeVisible();

    // 關閉 Drawer
    await page.locator('button', { hasText: '關閉' }).click();
    await expect(drawer).not.toBeVisible();

    // 7. 驗證 13 名數學缺排課學生 (以 tierMismatch=false + hasIssues=true 篩選)
    await mismatchSelect.selectOption({ label: '✓ 僅顯示級距吻合' });
    const issuesSelect = page.locator('select', { has: page.locator('option', { hasText: '全部問題狀態' }) });
    await issuesSelect.selectOption({ label: '僅顯示有待確認事項' });

    // 驗證清單中存在報名 國小數學-一[團] 的學生
    await expect(table.locator('tbody tr').first()).toBeVisible();
    await expect(page.locator('.data-table tbody')).toContainText('SCHEDULE_NOT_FOUND');
  });
});
