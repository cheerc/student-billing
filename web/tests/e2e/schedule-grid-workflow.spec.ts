import { test, expect } from '@playwright/test';

/**
 * 04 §8 UX01／UX05–08／UX24：
 * 空 DB 先課表後匯入工作流程：
 * 進入設定頁（不阻擋）→ 89 列平鋪網格 → 唯讀照顧窗口 → 編輯時段 → 確認變更 → 儲存課表 (settings_only)。
 */
test.describe('R2 展示一：空 DB 先課表後匯入排課工作流程 E2E', () => {
  test('UX01/UX24: 空 DB 進入 /settings → 平鋪網格與唯讀窗口 → 編輯時段 → 確認變更 → 儲存課表 (settings_only)', async ({
    page,
  }) => {
    // 1. 空 DB 狀態下直接存取 /settings（UX01：解除先匯入名單之阻擋）
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });

    // 2. 驗證唯讀照顧窗口摘要（UX24：安親 13:00–16:00、課輔 16:30–19:30，無編輯輸入框）
    const winBar = page.locator('.windows-bar');
    await expect(winBar).toBeVisible();
    await expect(winBar).toContainText('安親窗口');
    await expect(winBar).toContainText('13:00–16:00');
    await expect(winBar).toContainText('課輔窗口');
    await expect(winBar).toContainText('16:30–19:30');

    // 3. 驗證 89 列平鋪排課網格正常載入
    const scheduleTable = page.locator('.schedule-table');
    await expect(scheduleTable).toBeVisible();
    await expect(page.locator('.count-summary')).toContainText('時段');

    // 4. 編輯第一列時間觸發 dirty 狀態
    const firstStartTime = page.locator('input.input-time').first();
    await firstStartTime.fill('13:30');
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    // 5. 點擊「確認變更」開啟 ImpactDialog
    await page.locator('button', { hasText: '確認變更' }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    // 6. 驗證 settings_only 專屬呈現（提示尚未匯入學生、主按鈕為「儲存課表」）
    await expect(dialog).toContainText('尚未匯入學生');
    const saveBtn = dialog.locator('button', { hasText: '儲存課表' });
    await expect(saveBtn).toBeVisible();

    // 7. 點擊「儲存課表」完成 settings_only 儲存
    await saveBtn.click();
    await expect(page.locator('#toast')).toContainText('課表已成功儲存', { timeout: 15000 });
    await expect(dialog).not.toBeVisible();
  });
});
