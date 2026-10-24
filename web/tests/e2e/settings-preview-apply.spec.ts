import { test, expect } from '@playwright/test';
import path from 'path';
import { applyLegacySemanticRecommendations } from './helpers/legacy-semantics';

/**
 * specs/10 §4（T05 重寫對照 R2 UX03／UX09／UX10）：
 * 舊 spec（T05：勾選數學一→一A → preview 13人/-0.5/5→18 → 套用）對齊 R2 新工作流程：
 * - 舊版在同一頁面展開待設定清單並以「預覽影響」／「套用並重算」按鈕提交；
 * - 新版（R2）按 specs/09 §3 採用「課表」與「班名對應」頁籤，由底部操作列「確認變更」開啟 ImpactDialog，
 *   在確認視窗內顯示 13 人天數變化與「系統計算天數與米豆奶入班天數不符：5 人 → 18 人」（D39；單位是人），再點擊「儲存並更新結果」完成原子套用與重算。
 */
test.describe('T05 設定 preview→apply E2E（R2 課表與班名對應工作流程）', () => {
  test('T05 (UX03/UX09/UX10): 上傳 → 啟用 → 班名對應勾選數學一→一A → ImpactDialog 預覽 13人/18筆差異 → 儲存並更新結果', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // 1. 上傳 ERP 名冊
    await page.goto('/imports');
    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    await page.locator('input[type="file"]').setInputFiles(fixturePath);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    // 2. 首頁啟用為正式 run（R5 文案：按鈕「啟用為正式 Run ▶」→「使用這份名單」，與匯入頁一致；
    //    改為必須存在——舊版「有才點」的條件式會在按鈕消失時無聲略過）
    await page.goto('/');
    const activateBtn = page.locator('button', { hasText: '使用這份名單' });
    await expect(activateBtn).toBeVisible();
    await activateBtn.click();
    await expect(page.locator('.data-banner-current', { hasText: '目前使用的資料' })).toBeVisible({ timeout: 15000 });
    await applyLegacySemanticRecommendations(page);

    // 3. 進入課表設定頁（R2 新標題：課表設定）
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });

    // 4. 切換至「班名對應」頁籤
    await page.locator('button', { hasText: '班名對應' }).click();
    await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 10000 });

    // 5. D32-C 動態候選：為「國小數學-一」填目標「國小數學-一A」後核取對應
    const row = page.locator('tr', { hasText: '國小數學-一' });
    await expect(row).toBeVisible();
    const targetInput = row.locator('input.input-target-classname');
    await targetInput.fill('國小數學-一A');
    await row.locator('input[type="checkbox"]').check();

    // 6. 點擊底部操作列「確認變更」開啟 ImpactDialog 預覽影響 (D18)
    await page.locator('button', { hasText: '確認變更' }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    // 斷言 D18 預期結果：13 人天數變化、天數不符 5 人 → 18 人（D39 定稿文案；單位是人，不是筆）
    await expect(dialog).toContainText('13 人');
    await expect(dialog).toContainText('系統計算天數與米豆奶入班天數不符：5 人 → 18 人', { useInnerText: true });
    await expect(dialog).not.toContainText('mismatch', { useInnerText: true });

    // 7. 點擊確認視窗內主按鈕「儲存並更新結果」完成套用與重算
    await dialog.locator('button', { hasText: '儲存並更新結果' }).click();

    // 驗證套用成功 toast 通知且確認視窗已關閉
    await expect(page.locator('#toast')).toContainText('課表已套用並完成重算', { timeout: 15000 });
    await expect(dialog).not.toBeVisible();
  });
});
