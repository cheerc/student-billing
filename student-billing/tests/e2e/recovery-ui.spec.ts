import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('T06: 故障恢復、歷程查閱與剩餘 UI 契約 E2E 驗收測試', () => {
  test('完整端到端旅程：上傳 → 啟用 → 歷程查閱 → 問題定位跳轉 → 待設定班級提示 → 重置篩選', async ({ page }) => {
    // 1. 上傳 ERP 試算表
    await page.goto('/imports');
    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(fixturePath);

    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    // 2. 查閱批次與歷程頁面 (/history)
    await page.goto('/history');
    await expect(page.locator('h2', { hasText: '批次清單與歷史 Run 查閱' })).toBeVisible();
    const batchTable = page.locator('.table-container', { hasText: '匯入批次歷程清單' });
    await expect(batchTable.locator('.data-table tbody')).toContainText('conforming-erp-fixture.xlsx');

    // 3. 返回首頁啟用正式 Run
    await page.goto('/');
    const activateBtn = page.locator('button', { hasText: '啟用為正式 Run' });
    if (await activateBtn.isVisible()) {
      await activateBtn.click();
    }

    // 驗證首頁進入正式 Run 狀態 (展示B)
    await expect(page.locator('text=已啟用正式計算 Run')).toBeVisible({ timeout: 15000 });

    // 4. 前往 /history 驗證正式 Run 標記為現行 Active
    await page.goto('/history');
    const runTable = page.locator('.table-container', { hasText: '正式計算 Run 歷程清單' });
    await expect(runTable.locator('.data-table tbody')).toContainText('現行 Active');

    // 5. 返回首頁測試問題碼跳轉篩選
    await page.goto('/');
    const issueCodeSelect = page.locator('select', { has: page.locator('option', { hasText: '問題代碼定位...' }) });
    await issueCodeSelect.selectOption({ label: '排課缺漏 (SCHEDULE_NOT_FOUND, 13人)' });

    // 總表表格顯示 13 人且含有 SCHEDULE_NOT_FOUND
    const table = page.locator('.data-table');
    await expect(table.locator('tbody tr')).toHaveCount(13);
    await expect(table.locator('tbody tr').first()).toContainText('SCHEDULE_NOT_FOUND');

    // 6. 點擊學生列展開明細 Drawer，確認來源列座標與排課問題說明
    await table.locator('tbody tr').first().click();
    const drawer = page.locator('h3', { hasText: 'STU' });
    await expect(drawer).toBeVisible();
    await expect(page.locator('text=來源試算表第')).toBeVisible();
    await expect(page.locator('text=排課缺漏，採相容 fallback 數值比較').first()).toBeVisible();

    // 關閉 Drawer
    await page.locator('button', { hasText: '關閉 ✕' }).click();
    await expect(drawer).not.toBeVisible();

    // 7. 測試「重置篩選 ✕」按鈕
    const resetBtn = page.locator('button', { hasText: '重置篩選 ✕' });
    await expect(resetBtn).toBeVisible();
    await resetBtn.click();

    // 驗證恢復為全體學生 (顯示 50 筆分頁，共 477 人)
    await expect(page.locator('text=共 477 人')).toBeVisible();

    // 8. 測試待設定班級選取與提示橫幅
    const classSelect = page.locator('select', { has: page.locator('option', { hasText: '全部班級' }) });
    await classSelect.selectOption({ label: '國小數學-一' });

    // 驗證待設定班級提示橫幅出現且含有前往設定連結
    const unmappedAlert = page.locator('text=待設定班級提示：');
    await expect(unmappedAlert).toBeVisible();
    await expect(page.locator('a', { hasText: '前往課程設定' })).toBeVisible();
  });
});
