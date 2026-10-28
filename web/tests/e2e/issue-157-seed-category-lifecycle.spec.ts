import { test, expect, type Page } from '@playwright/test';
import { classRow, classRows, reloadSettings, resetSeedSettings, saveSettings } from './helpers/d2c-settings';

async function renameWholeClass(page: Page, from: string, to: string) {
  const expectedRows = await classRows(page, from).count();
  const changed = await page.locator('input.input-classname').evaluateAll((inputs, args) => {
    const [from, to] = args as [string, string];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    let count = 0;
    for (const el of inputs) {
      if ((el as HTMLInputElement).value !== from) continue;
      setter?.call(el, to);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      count++;
    }
    return count;
  }, [from, to]);
  expect(changed, `必須改到「${from}」的全部時段列`).toBe(expectedRows);
  expect(changed).toBeGreaterThan(0);
}

async function saveAndReload(page: Page) {
  await saveSettings(page);
  await reloadSettings(page);
}

test.describe('Issue #157 & D61：seed 類別生命週期與多科折扣持久化', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await resetSeedSettings(page);
    await reloadSettings(page);
    // 預設在安親頁籤，切換至數學頁籤
    await page.locator('#class-type-tab-math').click();
  });

  test('seed 班改名後，多科折扣與課程類型隨班帶走，存檔重新載入後值一致', async ({ page }) => {
    await renameWholeClass(page, '國小數學-三A', '國小數學-三A新名');
    const renamed = classRow(page, '國小數學-三A新名');
    const radio = renamed.locator('div[role="radiogroup"][aria-label*="是否有多科折扣"]');
    await expect(radio.locator('input[value="true"]')).toBeChecked();

    await saveAndReload(page);
    await page.locator('#class-type-tab-math').click();
    await expect(
      classRow(page, '國小數學-三A新名').locator('div[role="radiogroup"][aria-label*="是否有多科折扣"]').locator('input[value="true"]')
    ).toBeChecked();
  });

  test('使用者先改多科折扣為「否」的 seed 班改名並存檔後仍為否', async ({ page }) => {
    const row = classRow(page, '國小數學-三B');
    await row.locator('div[role="radiogroup"][aria-label*="是否有多科折扣"]').locator('label.no-option').click();

    await renameWholeClass(page, '國小數學-三B', '國小數學-三B改名');
    const renamed = classRow(page, '國小數學-三B改名');
    await expect(
      renamed.locator('div[role="radiogroup"][aria-label*="是否有多科折扣"]').locator('input[value="false"]')
    ).toBeChecked();

    await saveAndReload(page);
    await page.locator('#class-type-tab-math').click();
    await expect(
      classRow(page, '國小數學-三B改名').locator('div[role="radiogroup"][aria-label*="是否有多科折扣"]').locator('input[value="false"]')
    ).toBeChecked();
  });

  test('兩個相同 seed 類別合併後，存檔重新載入仍保留畫面值', async ({ page }) => {
    await renameWholeClass(page, '國小數學-四A', '國小數學-四年級合班');
    await renameWholeClass(page, '國小數學-四B', '國小數學-四年級合班');
    const merged = classRow(page, '國小數學-四年級合班');
    await expect(
      merged.locator('div[role="radiogroup"][aria-label*="是否有多科折扣"]').locator('input[value="true"]')
    ).toBeChecked();

    await saveAndReload(page);
    await page.locator('#class-type-tab-math').click();
    await expect(
      classRow(page, '國小數學-四年級合班').locator('div[role="radiogroup"][aria-label*="是否有多科折扣"]').locator('input[value="true"]')
    ).toBeChecked();
  });

  test('未改名 seed 班在其他班修改存檔後仍保留多科折扣為是', async ({ page }) => {
    const row5A = classRow(page, '國小數學-五A');
    await row5A.locator('div[role="radiogroup"][aria-label*="是否有多科折扣"]').locator('label.no-option').click();
    await saveAndReload(page);
    await page.locator('#class-type-tab-math').click();

    await expect(
      classRow(page, '國小數學-五B').locator('div[role="radiogroup"][aria-label*="是否有多科折扣"]').locator('input[value="true"]')
    ).toBeChecked();
  });
});
