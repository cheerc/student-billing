import { test, expect } from '@playwright/test';

/**
 * D2d E（RED）：v2 active 時只勾「改用新規則」、不改其他設定，也能走完整升級旅程。
 *
 * Q11：升級必須是明確動作，但**不得**要求使用者為了開預覽而先做無關的課表修改。
 * 本檔依 Lead 裁定 (d) 使用 `--seed-v2-active` 執行：
 * 每輪 server 啟動前，scripts/e2e-seed-v2-active.ts 以既有 application／adapter
 * 函式建立「一名年級 4、重複報名兩班數學」的 v2 active run（課輔 4.5 天；
 * 同一份草稿在 v3 下為 4 天 → 升級前後必有差異）。
 *
 * 斷言點全部是使用者可觀察行為：
 *   1. 只勾升級 → 「確認變更」可用（現行 isDirty 不含 upgradeConfirmed，按鈕停用）
 *   2. 預覽顯示受影響學生數 1 人與天數變動明細（現行 before/after 同版本 → 0 人）
 *   3. 儲存後產生新的 v3 結果，舊 v2 run 保留
 */
test.describe('D2d E: v2 active 升級旅程（只勾升級即可預覽）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    // 前置：本檔必須真的在「既有 v2 DB」上，否則升級勾選不會出現
    await expect(page.locator('[data-upgrade-banner]')).toBeVisible({ timeout: 15000 });
  });

  test('只勾升級、不改課表 → 可進入預覽並看到 v2→v3 差異', async ({ page }) => {
    await page.locator('[data-upgrade-confirm]').check();

    // 現行：isDirty 不含 upgradeConfirmed → 「確認變更」停用，無法進入預覽
    const review = page.getByRole('button', { name: '確認變更', exact: true });
    await expect(review).toBeEnabled();
    await review.click();

    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    // v2（課輔 4.5）→ v3（課輔 4）：一名學生受影響
    await expect(dialog.locator('.metric-card', { hasText: '受影響學生數' }).locator('.metric-value')).toHaveText('1 人');
    await expect(dialog).toContainText('天數變動明細');
  });

  test('完整旅程：升級預覽 → 儲存 → 產生 v3 新結果、舊 v2 結果保留', async ({ page }) => {
    const before = await page.request.get('/api/v1/runs/current');
    const beforeJson = await before.json();
    const oldRunId = beforeJson.activeRunId as string;
    expect(oldRunId).toBeTruthy();

    await page.locator('[data-upgrade-confirm]').check();
    await page.getByRole('button', { name: '確認變更', exact: true }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    const applied = page.waitForResponse((r) => r.url().endsWith('/api/v1/settings/apply') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: '儲存並更新結果' }).click();
    expect((await applied).ok()).toBe(true);
    await expect(dialog).toBeHidden();

    // 新 run 為 v3
    const after = await page.request.get('/api/v1/runs/current');
    const afterJson = await after.json();
    expect(afterJson.activeRunId).not.toBe(oldRunId);
    expect(afterJson.run?.ruleSetVersion).toBe('erp-tag-v3');

    // 舊 v2 run 仍可讀、仍標 v2（不因升級被改寫或刪除）
    const old = await page.request.get(`/api/v1/runs/${oldRunId}/students`);
    expect(old.ok()).toBe(true);
  });
});
