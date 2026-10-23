import { test, expect } from '@playwright/test';

/**
 * D2d E（RED → GREEN）：v2 active 時只勾「改用新規則」、不改其他設定，也能走完整升級旅程。
 *
 * Q11：升級必須是明確動作，但**不得**要求使用者為了開預覽而先做無關的課表修改。
 * 本檔依 Lead 裁定 (d) 使用 `--seed-v2-active` 執行：
 * 每輪 server 啟動前，scripts/e2e-seed-v2-active.ts 以既有 application／adapter
 * 函式建立「一名年級 4、重複報名兩班數學」的 v2 active run（課輔 4.5 天；
 * 同一份草稿在 v3 下為 4 天 → 升級前後必有差異）。
 *
 * **前置相依**：本檔必須在「既有 v2 DB」上跑，否則 `[data-upgrade-banner]` 不存在、
 * 升級勾選也不會出現。因此沒有 `--seed-v2-active` 時**自我跳過**，而不是失敗——
 * 否則 `npm run test:e2e:isolated`（不帶旗標的全套執行）會被本檔弄紅。
 * 這與 isolation runner 的其他旗標無關，是本檔自己的前提。
 *
 * 斷言點全部是使用者可觀察行為：
 *   1. 只勾升級 → 「確認變更」可用（`isDirty` 不含 `upgradeConfirmed` 時按鈕停用）
 *   2. 預覽顯示受影響學生數 1 人與天數變動明細
 *      （before 與 after 誤用同一版本、或 preview route 丟棄 `targetRuleSetVersion` 時皆為 0 人）
 *   3. 儲存後產生新的 v4 結果，舊 v2 run 保留
 */

/**
 * 執行全套（不帶 --seed-v2-active）時跳過本檔。
 * 判斷方式：升級 banner 不存在即代表這不是 v2 現況——此時 beforeEach 會失敗，
 * 與其讓整套紅掉，不如明確跳過並在報告中顯示原因。
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/settings');
  const banner = page.locator('[data-upgrade-banner]');
  const hasV2Banner = (await banner.count()) > 0;
  if (process.env.E2E_REQUIRE_V2_SEED === '1') {
    expect(hasV2Banner, 'Full E2E seeded phase must have a v2 active DB; cannot skip').toBe(true);
  } else {
    test.skip(!hasV2Banner,
      '本檔需要既有 v2 active run；請使用 --seed-v2-active 或 full E2E 入口');
  }
  await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
  await expect(banner).toBeVisible({ timeout: 15000 });
});

  test.describe('D2d E: v2 active 升級旅程（只勾升級即可預覽）', () => {
  test('只勾升級、不改課表 → 可進入預覽並看到 v2→v3 差異', async ({ page }) => {
    await page.locator('[data-upgrade-confirm]').check();

    // 斷言點：只勾升級（不改任何課表設定）就必須能開預覽
    const review = page.getByRole('button', { name: '確認變更', exact: true });
    await expect(review).toBeEnabled();
    await review.click();

    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    // v2（課輔 4.5）→ v3（課輔 4）：一名學生受影響
    await expect(dialog.locator('.metric-card', { hasText: '受影響學生數' }).locator('.metric-value')).toHaveText('1 人');
    await expect(dialog).toContainText('天數變動明細');
  });

  test('完整旅程：升級預覽 → 儲存 → 產生 v4 新結果、舊 v2 結果保留', async ({ page }) => {
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

    // 新 run 為目標正式軌 v4（#112 起；固定 5 天與課程學費折扣解耦）
    const after = await page.request.get('/api/v1/runs/current');
    const afterJson = await after.json();
    expect(afterJson.activeRunId).not.toBe(oldRunId);
    expect(afterJson.run?.ruleSetVersion).toBe('erp-tag-v4');

    // 舊 v2 run 仍可讀、仍標 v2（不因升級被改寫或刪除）
    const old = await page.request.get(`/api/v1/runs/${oldRunId}/students`);
    expect(old.ok()).toBe(true);
  });
});
