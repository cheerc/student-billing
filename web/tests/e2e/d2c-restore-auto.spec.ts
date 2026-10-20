import { test, expect } from '@playwright/test';
import { resetSeedSettings, saveSettings, reloadSettings } from './helpers/d2c-settings';

/** D37／UX48／UX58：儲存、重新載入後恢復自動，必須真的持久化，不能只改畫面。 */
test.beforeEach(async ({ page }) => {
  await resetSeedSettings(page);
  await page.goto('/settings');
  // #80：屬性已併入時段表格，改等那張表
  await expect(page.locator('.schedule-table')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await resetSeedSettings(page);
});

test('已儲存的手動類別：reload → 恢復自動 → 儲存 → reload 仍為自動數學班', async ({ page }) => {
  const name = '國小數學-四A';
  await page.locator(`[data-category-select="${name}"]`).first().selectOption('none');
  await saveSettings(page);
  await reloadSettings(page);
  await page.locator(`[data-restore-auto="${name}"]`).first().click();
  await expect(page.locator(`[data-category-select="${name}"]`).first()).toHaveValue('math');
  await saveSettings(page);
  await reloadSettings(page);
  await expect(page.locator(`[data-category-select="${name}"]`).first()).toHaveValue('math');
});

test('已儲存的安親班手動類別：reload → 恢復自動 → 儲存 → reload 仍為自動且為安親課輔班', async ({ page }) => {
  await page.locator('#class-type-tab-care').click();
  const name = '國小輔導-四年級';
  await page.locator(`[data-category-select="${name}"]`).first().selectOption('none');
  await saveSettings(page);
  await reloadSettings(page);
  await page.locator('#class-type-tab-care').click();
  await page.locator(`[data-restore-auto="${name}"]`).first().click();
  await expect(page.locator(`[data-category-select="${name}"]`).first()).toHaveValue('care');
  await saveSettings(page);
  await reloadSettings(page);
  await page.locator('#class-type-tab-care').click();
  await expect(page.locator(`[data-category-select="${name}"]`).first()).toHaveValue('care');
});

test('已儲存手動值的班改名後恢復自動：以目前班名重新偵測並持久化', async ({ page }) => {
  const from = '國小數學-四A';
  const to = '寫功課-合成班';
  await page.locator(`[data-category-select="${from}"]`).first().selectOption('care');
  await saveSettings(page);
  await reloadSettings(page);
  const inputs = page.locator('input.input-classname');
  const indexes = await inputs.evaluateAll((elements, name) =>
    elements.flatMap((element, index) => (element as HTMLInputElement).value === name ? [index] : []), from
  );
  expect(indexes.length).toBeGreaterThan(0);
  // 未使用搜尋／星期篩選，列索引固定；逐列真實 fill 讓 React 完整處理每次改名。
  for (const index of indexes) await inputs.nth(index).fill(to);
  await expect(page.locator(`[data-category-select="${to}"]`).first()).toHaveValue('care');
  await page.locator(`[data-restore-auto="${to}"]`).first().click();
  await expect(page.locator(`[data-category-select="${to}"]`).first()).toHaveValue('none');
  await saveSettings(page);
  await reloadSettings(page);
  await expect(page.locator(`[data-category-select="${to}"]`).first()).toHaveValue('none');
});
