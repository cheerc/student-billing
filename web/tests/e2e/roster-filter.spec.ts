import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('名冊篩選 E2E 驗收測試', () => {
  test('上傳 ERP 試算表 → 首頁持久化展示 → 班級與條件篩選 → 重新整理依然存在', async ({ page }) => {
    // 1. 進入匯入頁面
    // R3：匯入頁文案去技術化（specs/09 §4），標題改為「上傳ERP匯出的學生Excel」
    await page.goto('/imports');
    await expect(page.locator('h1')).toContainText('匯入學生');
    await expect(page.locator('h2')).toContainText('上傳ERP匯出的學生Excel');

    // 2. 上傳測試用保形匿名 fixture
    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(fixturePath);

    // 等待解析完成並呈現統計
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.stat-card', { hasText: '學生總人數' })).toContainText('477');

    // 3. 點擊返回首頁
    await page.goto('/');

    // 4. 首頁應展示就緒名冊或已啟用狀態列與統計
    // R3：日常介面去除「展示A/B」技術字（specs/09 §7），改以名冊狀態描述
    await expect(page.getByText('已載入就緒名單')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('尚未啟用')).toBeVisible();
    await expect(page.locator('.stat-card', { hasText: '符合篩選學生數' })).toContainText('477');

    // 5. 班級候選篩選 (四年級 A/B 分開)
    const classSelect = page.locator('select', { has: page.locator('option', { hasText: '全部班級' }) });
    await expect(classSelect).toBeVisible();

    // 篩選四年級 A
    await classSelect.selectOption({ label: '國小輔導-四年級A' });
    const table = page.locator('.data-table');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr')).not.toHaveCount(0);
    // 確認表格內都是四年級A
    await expect(table.locator('tbody tr').first()).toContainText('國小輔導-四年級A');

    // 篩選四年級 B
    await classSelect.selectOption({ label: '國小輔導-四年級B' });
    await expect(table.locator('tbody tr').first()).toContainText('國小輔導-四年級B');

    // 6. 搜尋學生
    const searchInput = page.locator('input[placeholder*="搜尋"]');
    await searchInput.fill('STU0001');
    // 清除班級篩選回全部班級
    await classSelect.selectOption({ label: '全部班級' });
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table.locator('tbody tr')).toContainText('STU0001');

    // 7. 重新整理頁面，驗證持久化仍在
    await page.reload();
    await expect(page.getByText('已載入就緒名單')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.stat-card', { hasText: '符合篩選學生數' })).toContainText('477');
  });
});
