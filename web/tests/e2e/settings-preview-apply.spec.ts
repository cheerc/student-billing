import { test, expect } from '@playwright/test';
import path from 'path';

/**
 * specs/10 §4（T05 重寫對照 R2 UX03／UX09／UX10；#189 D62 改寫）：
 * 舊 spec（T05：勾選數學一→一A → preview 13人/-0.5/5→18 → 套用）對齊新版「班名同步」工作流程：
 * - 舊版在同一頁面展開待設定清單並以「預覽影響」／「套用並重算」按鈕提交；
 * - R2 曾以「班名對應」頁籤建立別名；D62 改為「班名同步」——逐列選目標課表班級、整班改名，
 *   由底部操作列「確認變更」開啟 ImpactDialog，在確認視窗內顯示 13 人天數變化與
 *   「系統計算天數與米豆奶入班天數不符：4 人 → 17 人」（D39；單位是人），再點擊「儲存並更新結果」完成原子套用與重算。
 */
test.describe('T05 設定 preview→apply E2E（R2 課表與班名同步工作流程）', () => {
  test('T05 (UX03/UX09/UX10): 上傳 → 啟用 → 班名同步「國小數學-一A」改名為「國小數學-一」 → ImpactDialog 預覽 13人/18筆差異 → 儲存並更新結果', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // 1. 上傳 ERP 名冊
    await page.goto('/imports');
    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    await page.locator('input[type="file"]').setInputFiles(fixturePath);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    // 2. 匯入頁啟用為正式 run 並前往核對結果
    const activateBtn = page.locator('button', { hasText: '使用這份名單' });
    await expect(activateBtn).toBeVisible({ timeout: 15000 });
    await activateBtn.click();
    await page.locator('a', { hasText: '前往核對結果' }).click();
    await expect(page.locator('.data-banner-current', { hasText: '目前使用的資料' })).toBeVisible({ timeout: 15000 });

    // 3. 進入課表設定頁（R2 新標題：課表設定）
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });

    // 4. 切換至「班名同步」頁籤
    await page.locator('button[role="tab"]', { hasText: '班名同步' }).click();
    await expect(page.locator('[data-class-name-sync-panel]')).toBeVisible({ timeout: 10000 });

    // 5. D62 逐列同步：把「國小數學-一A」整班改名為米豆奶班名「國小數學-一」
    const row = page.locator('tr[data-mismatch-row="國小數學-一"]');
    await expect(row).toBeVisible();
    await row.locator('button', { hasText: '同步到既有班級' }).click();
    await page
      .locator('select[aria-label="選擇同步目標課表班級"]')
      .selectOption({ value: '國小數學-一A' });
    await page.locator('button', { hasText: '暫存同步' }).click();
    await expect(row).toContainText('已暫存：國小數學-一A → 國小數學-一（未儲存）');

    // 6. 點擊底部操作列「確認變更」開啟 ImpactDialog 預覽影響 (D18)
    await page.locator('button', { hasText: '確認變更' }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    // 斷言 D18 預期結果：13 人天數變化、天數不符 4 人 → 17 人（D39 定稿文案；單位是人，不是筆）
    await expect(dialog).toContainText('13 人');
    await expect(dialog).toContainText('系統計算天數與米豆奶入班天數不符：4 人 → 17 人', { useInnerText: true });
    await expect(dialog).not.toContainText('mismatch', { useInnerText: true });

    // 7. 點擊確認視窗內主按鈕「儲存並更新結果」完成套用與重算
    await dialog.locator('button', { hasText: '儲存並更新結果' }).click();

    // 驗證套用成功 toast 通知且確認視窗已關閉
    await expect(page.locator('#toast')).toContainText('課表已套用並完成重算', { timeout: 15000 });
    await expect(dialog).not.toBeVisible();
  });
});
