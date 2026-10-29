import { test, expect } from '@playwright/test';
import { ensureClassTypeTab, selectClassTypeTab } from './helpers/d2c-settings';

/**
 * 04 §8 UX01／UX05–08／UX24：
 * 空 DB 先課表後匯入工作流程：
 * 進入設定頁（不阻擋）→ 平鋪網格 → 唯讀照顧窗口 → 編輯時段 → 確認變更 → 儲存課表 (settings_only)。
 *
 * D61（09 §3.1）起課表是「一頁籤一張表」，預設頁籤是**安親課輔班**：
 *  - 安親頁籤沒有時段欄，數量摘要只有 `共 N 個班級`；
 *  - 排課頁籤（美語／數學／其他／不排課）才顯示 `共 N 個班級 · M 個時段`。
 * 因此「編輯時段」必須先切到排課頁籤，並以班名定位該列（見 helpers）。
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

    // 3. 安親頁籤（預設）：平鋪網格正常載入，摘要只有班級數、不含時段（09 §3.1）
    //    8 個安親班（seed-manifest.ts 的 SEED_CLASS_TYPES），每班只列 1 列
    const scheduleTable = page.locator('.schedule-table');
    await expect(scheduleTable).toBeVisible();
    await expect(page.locator('#class-type-tab-care')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.count-summary')).toHaveText('共 8 個班級');

    // 4. 切到排課頁籤：摘要變成 `共 N 個班級 · M 個時段`
    //    數學班 12 班、24 個時段（實測值，來源為 seed JSON 的 math 班時段數）
    await selectClassTypeTab(page, 'math');
    await expect(page.locator('#schedule-weekday-filter')).toBeVisible();
    await expect(page.locator('.count-summary')).toHaveText('共 12 個班級 · 24 個時段');

    // 5. 編輯一列時間觸發 dirty 狀態（以班名定位，不用整表第一個時段）
    //    四A 首列 seed 值為週三 13:30–15:00，因此這裡必須填「不同的值」才會真的改到草稿
    const row = await ensureClassTypeTab(page, '國小數學-四A');
    await row.locator('input.input-time').first().fill('14:10');
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    // 6. 點擊「確認變更」開啟 ImpactDialog
    await page.locator('button', { hasText: '確認變更' }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    // 7. 驗證 settings_only 專屬呈現（提示尚未匯入學生、主按鈕為「儲存課表」）
    await expect(dialog).toContainText('尚未匯入學生');
    const saveBtn = dialog.locator('button', { hasText: '儲存課表' });
    await expect(saveBtn).toBeVisible();

    // 8. 點擊「儲存課表」完成 settings_only 儲存
    await saveBtn.click();
    await expect(page.locator('#toast')).toContainText('課表已成功儲存', { timeout: 15000 });
    await expect(dialog).not.toBeVisible();
  });
});
