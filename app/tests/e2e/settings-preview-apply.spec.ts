import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('T05 設定 preview→apply E2E', () => {
  test('上傳 → 啟用 → 設定頁勾選數學一→一A → preview 13人/-0.5/5→18 → 套用並重算', async ({ page }) => {
    // 1. 上傳 ERP
    await page.goto('/imports');
    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    await page.locator('input[type="file"]').setInputFiles(fixturePath);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    // 2. 首頁啟用為正式 run
    await page.goto('/');
    const activateBtn = page.locator('button', { hasText: '啟用為正式 Run' });
    if (await activateBtn.isVisible()) {
      await activateBtn.click();
    }
    await expect(page.locator('text=已啟用正式計算 Run')).toBeVisible({ timeout: 15000 });

    // 3. 進入設定頁
    await page.goto('/settings');
    await expect(page.locator('h2', { hasText: '課程、時段與 alias 設定' })).toBeVisible({ timeout: 10000 });

    // 4. 雙向對照同畫面並列：待設定 12、seed 未出現 7
    await expect(page.locator('.table-title', { hasText: '待設定清單（12）' })).toBeVisible();
    await expect(page.locator('.table-title', { hasText: 'seed 本批未出現（7）' })).toBeVisible();

    // 5. 勾選 D18 候選 數學一 → 一A
    const d18 = page.locator('label', { hasText: '國小數學-一' }).first();
    await d18.locator('input[type="checkbox"]').check();

    // 6. 預覽影響
    await page.locator('button', { hasText: '預覽影響' }).click();
    await expect(page.locator('.table-title', { hasText: '影響預覽' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.table-title', { hasText: '影響預覽' })).toContainText('13 人天數變化');
    await expect(page.locator('.table-title', { hasText: '影響預覽' })).toContainText('mismatch 5 → 18');

    // 7. 套用並重算
    await page.locator('button', { hasText: '套用並重算' }).click();
    await expect(page.locator('.alert-success')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.alert-success')).toContainText('mismatch 18 筆');
  });
});
