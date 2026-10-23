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

test.describe('Issue #157 Ruling 6／8：seed 類別生命週期與撤回持久化', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await resetSeedSettings(page);
    await reloadSettings(page);
  });

  test('seed 班改名後，畫面值與存檔重新載入後的值一致', async ({ page }) => {
    await renameWholeClass(page, '國小數學-三A', '國小數學-三A新名');
    const renamed = classRow(page, '國小數學-三A新名');
    await expect(renamed.locator('[data-category-select="國小數學-三A新名"]')).toHaveValue('unset');

    await saveAndReload(page);
    await expect(
      classRow(page, '國小數學-三A新名').locator('[data-category-select="國小數學-三A新名"]')
    ).toHaveValue('unset');
  });

  test('使用者先撤回的 seed 班改名並存檔後仍為 unset', async ({ page }) => {
    await classRow(page, '國小數學-三B')
      .locator('[data-category-select="國小數學-三B"]')
      .first()
      .selectOption('unset');
    await renameWholeClass(page, '國小數學-三B', '國小數學-三B撤回改名');
    await expect(
      classRow(page, '國小數學-三B撤回改名').locator('[data-category-select="國小數學-三B撤回改名"]')
    ).toHaveValue('unset');

    await saveAndReload(page);
    await expect(
      classRow(page, '國小數學-三B撤回改名').locator('[data-category-select="國小數學-三B撤回改名"]')
    ).toHaveValue('unset');
  });

  test('兩個相同 seed 類別合併後，存檔重新載入仍保留畫面值', async ({ page }) => {
    await renameWholeClass(page, '國小數學-四A', '國小數學-四年級合班');
    await renameWholeClass(page, '國小數學-四B', '國小數學-四年級合班');
    const merged = classRow(page, '國小數學-四年級合班');
    await expect(merged.locator('[data-category-select="國小數學-四年級合班"]')).toHaveValue('unset');

    await saveAndReload(page);
    await expect(
      classRow(page, '國小數學-四年級合班').locator('[data-category-select="國小數學-四年級合班"]')
    ).toHaveValue('unset');
  });

  test('未改名 seed 班在其他類別修改存檔後仍取得 seed 基準', async ({ page }) => {
    await classRow(page, '國小數學-五A')
      .locator('[data-category-select="國小數學-五A"]')
      .first()
      .selectOption('none');
    await saveAndReload(page);

    await expect(
      classRow(page, '國小數學-五B').locator('[data-category-select="國小數學-五B"]')
    ).toHaveValue('math');
  });

  test('選回「未設定」並存檔重新載入後仍是 unset', async ({ page }) => {
    await classRow(page, '國小數學-六A')
      .locator('[data-category-select="國小數學-六A"]')
      .first()
      .selectOption('unset');
    await expect(
      classRow(page, '國小數學-六A').locator('[data-category-select="國小數學-六A"]')
    ).toHaveValue('unset');

    await saveAndReload(page);
    await expect(
      classRow(page, '國小數學-六A').locator('[data-category-select="國小數學-六A"]')
    ).toHaveValue('unset');
  });
});
