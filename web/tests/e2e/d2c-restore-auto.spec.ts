import { test, expect } from '@playwright/test';
import { resetSeedSettings, saveSettings, reloadSettings } from './helpers/d2c-settings';

/** D37／UX48／UX58：儲存、重新載入後恢復自動，必須真的持久化，不能只改畫面。 */
test.beforeEach(async ({ page }) => {
  await resetSeedSettings(page);
  await page.goto('/settings');
  await expect(page.locator('[data-class-attributes-panel]')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await resetSeedSettings(page);
});

test('已儲存的手動類別：reload → 恢復自動 → 儲存 → reload 仍為自動數學班', async ({ page }) => {
  const name = '國小數學-四A';
  await page.locator(`[data-category-select="${name}"]`).selectOption('none');
  await saveSettings(page);
  await reloadSettings(page);
  await expect(page.locator(`[data-category-source="${name}"]`)).toHaveText('手動');
  await page.locator(`[data-restore-auto="${name}"]`).click();
  await expect(page.locator(`[data-category-select="${name}"]`)).toHaveValue('math');
  await saveSettings(page);
  await reloadSettings(page);
  await expect(page.locator(`[data-category-source="${name}"]`)).toHaveText('自動');
  await expect(page.locator(`[data-category-select="${name}"]`)).toHaveValue('math');
});

test('已儲存的手動固定 5 天：reload → 恢復自動 → 儲存 → reload 仍為自動且未勾選', async ({ page }) => {
  const name = '兒童美語-Gino';
  await page.locator(`[data-fixed-five-toggle="${name}"]`).check();
  await saveSettings(page);
  await reloadSettings(page);
  await expect(page.locator(`[data-fixed-source="${name}"]`)).toHaveText('手動');
  await expect(page.locator(`[data-category-source="${name}"]`)).toHaveText('自動');
  await page.locator(`[data-restore-auto="${name}"]`).click();
  await expect(page.locator(`[data-fixed-five-toggle="${name}"]`)).not.toBeChecked();
  await saveSettings(page);
  await reloadSettings(page);
  await expect(page.locator(`[data-fixed-source="${name}"]`)).toHaveText('自動');
  await expect(page.locator(`[data-fixed-five-toggle="${name}"]`)).not.toBeChecked();
  await expect(page.locator(`[data-category-select="${name}"]`)).toHaveValue('english');
});

test('已儲存手動值的班改名後恢復自動：以目前班名重新偵測並持久化', async ({ page }) => {
  const from = '國小數學-四A';
  const to = '寫功課-合成班';
  await page.locator(`[data-category-select="${from}"]`).selectOption('care');
  await page.locator(`[data-fixed-five-toggle="${from}"]`).uncheck();
  await saveSettings(page);
  await reloadSettings(page);
  await expect(page.locator(`[data-category-source="${from}"]`)).toHaveText('手動');
  const inputs = page.locator('input.input-classname');
  await inputs.evaluateAll((elements, names) => {
    const [from, to] = names;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (const element of elements) {
      if ((element as HTMLInputElement).value !== from) continue;
      setter.call(element, to);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, [from, to]);
  await expect(page.locator(`[data-category-select="${to}"]`)).toHaveValue('care');
  await page.locator(`[data-restore-auto="${to}"]`).click();
  await expect(page.locator(`[data-category-source="${to}"]`)).toHaveText('自動');
  await expect(page.locator(`[data-category-select="${to}"]`)).toHaveValue('none');
  await expect(page.locator(`[data-fixed-five-toggle="${to}"]`)).toBeChecked();
  await saveSettings(page);
  await reloadSettings(page);
  await expect(page.locator(`[data-category-source="${to}"]`)).toHaveText('自動');
  await expect(page.locator(`[data-fixed-source="${to}"]`)).toHaveText('自動');
  await expect(page.locator(`[data-category-select="${to}"]`)).toHaveValue('none');
  await expect(page.locator(`[data-fixed-five-toggle="${to}"]`)).toBeChecked();
});
