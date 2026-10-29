import { test, expect, type Page } from '@playwright/test';
import { activateFixture } from './helpers/c-batch';
import { classRow } from './helpers/d2c-settings';

/**
 * D2b & D61: 班級五類型、是否有多科折扣與固定 5 天設定 UI 與影響預覽 E2E 驗收
 *
 * 驗收目標：
 *  - 課表每列顯示是否有多科折扣與固定 5 天單選組；
 *  - 手動切換「是／否」產生未儲存變更 (dirty) 並能取消還原；
 *  - 改班名後手動值隨班帶走；
 *  - 只有多科折扣變化時，影響預覽受影響人數正確（21 人）；
 *  - 同時有天數與科數變化時，受影響學生數去重（12 人）。
 */

async function renameWholeClass(page: Page, from: string, to: string) {
  await page
    .locator('input.input-classname')
    .evaluateAll((inputs, args) => {
      const [from, to] = args as [string, string];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      for (const el of inputs) {
        if ((el as HTMLInputElement).value !== from) continue;
        setter?.call(el, to);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, [from, to]);
}

async function setFirstStartTimeOfClass(page: Page, className: string, value: string) {
  const changed = await page.locator('input.input-time').evaluateAll((inputs, args) => {
    const [className, value] = args as [string, string];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    for (const el of inputs) {
      const row = el.closest('tr');
      const name = row?.querySelector<HTMLInputElement>('input.input-classname')?.value;
      if (name !== className) continue;
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  }, [className, value]);
  expect(changed, `課表上找不到班「${className}」的起始時間欄位`).toBe(true);
}

test.describe('D2b & D61：班級五類型、是否有多科折扣與固定 5 天設定 UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
  });

  test('D2b-2: 已儲存的多科折扣與固定 5 天單選組逐班顯示', async ({ page }) => {
    // 預設在 [安親課輔班] 頁籤：包含天數固定 5 天
    const careTable = page.locator('table.schedule-table-care');
    await expect(careTable).toBeVisible();
    await expect(careTable).toContainText('天數固定 5 天');

    const g4Row = classRow(page, '國小輔導-四年級');
    await expect(g4Row).toBeVisible();
    const g4FixedRadio = g4Row.locator('div[role="radiogroup"][aria-label="國小輔導-四年級 的天數固定 5 天"]');
    await expect(g4FixedRadio.locator('input[value="false"]')).toBeChecked();

    // 切至數學班頁籤：包含是否有多科折扣
    await page.locator('#class-type-tab-math').click();
    const mathTable = page.locator('table.schedule-table-math');
    await expect(mathTable).toBeVisible();
    await expect(mathTable).toContainText('是否有多科折扣');
    await expect(mathTable).not.toContainText('天數固定 5 天');

    const m4Row = classRow(page, '國小數學-四A');
    await expect(m4Row).toBeVisible();
    const m4MultiRadio = m4Row.locator('div[role="radiogroup"][aria-label="國小數學-四A 的是否有多科折扣"]');
    await expect(m4MultiRadio.locator('input[value="true"]')).toBeChecked();
  });

  test('D2b-2 & D61: 手動切換是否有多科折扣（是／否單選）', async ({ page }) => {
    await page.locator('#class-type-tab-math').click();
    const row = classRow(page, '國小數學-四A');
    const radioGroup = row.locator('div[role="radiogroup"][aria-label="國小數學-四A 的是否有多科折扣"]');

    // 點擊「否」
    await radioGroup.locator('label.no-option').click();
    await expect(radioGroup.locator('input[value="false"]')).toBeChecked();

    // 點擊「是」
    await radioGroup.locator('label.yes-option').click();
    await expect(radioGroup.locator('input[value="true"]')).toBeChecked();
  });

  test('D2b-2: 固定 5 天可手動開啟與關閉（安親課輔班專屬）', async ({ page }) => {
    const row = classRow(page, '國小輔導-四年級');
    const radioGroup = row.locator('div[role="radiogroup"][aria-label="國小輔導-四年級 的天數固定 5 天"]');

    // 點擊「是」開啟用固定 5 天
    await radioGroup.locator('label.yes-option').click();
    await expect(radioGroup.locator('input[value="true"]')).toBeChecked();

    // 點擊「否」關閉固定 5 天
    await radioGroup.locator('label.no-option').click();
    await expect(radioGroup.locator('input[value="false"]')).toBeChecked();
  });

  test('D2b-2 & D61: 手動指定的多科折扣隨改名帶走', async ({ page }) => {
    await page.locator('#class-type-tab-math').click();
    // 把「國小數學-四A」切換為多科折扣「否」
    const row = classRow(page, '國小數學-四A');
    await row.locator('div[role="radiogroup"][aria-label="國小數學-四A 的是否有多科折扣"]').locator('label.no-option').click();

    // 整班改名為「國小數學-四A改名」
    await renameWholeClass(page, '國小數學-四A', '國小數學-四A改名');

    // 使用者的指定帶著走：仍為「否」
    const renamed = classRow(page, '國小數學-四A改名');
    const renamedRadio = renamed.locator('div[role="radiogroup"][aria-label="國小數學-四A改名 的是否有多科折扣"]');
    await expect(renamedRadio.locator('input[value="false"]')).toBeChecked();
  });

  test('D2b-6: 只改多科折扣（不動時段）也會變更狀態為 dirty', async ({ page }) => {
    await expect(page.locator('.save-status-clean')).toBeVisible();
    await page.locator('#class-type-tab-math').click();
    const row = classRow(page, '國小數學-四A');
    await row.locator('div[role="radiogroup"][aria-label="國小數學-四A 的是否有多科折扣"]').locator('label.no-option').click();
    await expect(page.locator('.save-status-dirty')).toBeVisible();
  });

  test('D2b-6: 取消修改會把多科折扣還原（回到未儲存狀態）', async ({ page }) => {
    await page.locator('#class-type-tab-math').click();
    const row = classRow(page, '國小數學-四A');
    const radio = row.locator('div[role="radiogroup"][aria-label="國小數學-四A 的是否有多科折扣"]');
    await radio.locator('label.no-option').click();
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    await page.locator('button', { hasText: '取消修改' }).click();
    await expect(page.locator('.save-status-clean')).toBeVisible();
    await expect(radio.locator('input[value="true"]')).toBeChecked();
  });

  test.describe('D2b r2：影響預覽的受影響人數（去重）與別名提示', () => {
    test.beforeEach(async ({ page }) => {
      await activateFixture(page);
      await page.goto('/settings');
      await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });

      // D62：舊「班名對應」已改為「班名同步」；別名不再是建立對應的 UI，差異表不再有「已對應」語意
      await page.locator('button[role="tab"]', { hasText: '班名同步' }).click();
      await expect(page.locator('[data-class-name-sync-panel]')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('.pill', { hasText: '已對應' })).toHaveCount(0);
      await page.locator('button[role="tab"]', { hasText: /^課表/ }).click();
      await expect(page.locator('table.schedule-table')).toBeVisible();
    });

    test('R2-1: 只有多科折扣變化、天數不變時，受影響學生數仍正確（21 人）', async ({ page }) => {
      // 預設在安親頁籤：「國小輔導-一A」手動改多科折扣為「否」
      const row = classRow(page, '國小輔導-一A');
      await row.locator('div[role="radiogroup"][aria-label="國小輔導-一A 的是否有多科折扣"]').locator('label.no-option').click();
      await expect(page.locator('.save-status-dirty')).toBeVisible();

      await page.locator('button', { hasText: '確認變更' }).click();
      const dialog = page.locator('dialog.impact-dialog');
      await expect(dialog).toBeVisible({ timeout: 15000 });

      const metric = dialog.locator('.metric-card', { hasText: '受影響學生數' });
      await expect(metric).toBeVisible();
      // 合成名單手算：科數差異 21 人、折扣差異 13 人、天數差異 0 人 → 聯集去重 21 人
      await expect(metric.locator('.metric-value')).toHaveText('21 人');
    });

    test('R2-1: 同一人同時有天數與多科折扣變化時，受影響學生數去重（12 人）', async ({ page }) => {
      // 切至數學班頁籤
      await page.locator('#class-type-tab-math').click();
      const row = classRow(page, '國小數學-三A');
      // 改多科折扣為「否」產生科數與折扣變動
      await row.locator('div[role="radiogroup"][aria-label="國小數學-三A 的是否有多科折扣"]').locator('label.no-option').click();
      // 改不計扣天為「是」產生天數變動
      await row.locator('div[role="radiogroup"][aria-label*="不計扣天"]').locator('label.yes-option').click();
      await expect(page.locator('.save-status-dirty')).toBeVisible();

      await page.locator('button', { hasText: '確認變更' }).click();
      const dialog = page.locator('dialog.impact-dialog');
      await expect(dialog).toBeVisible({ timeout: 15000 });

      await expect(dialog).toContainText('天數變動明細');
      await expect(dialog.locator('.metric-card', { hasText: '受影響學生數' }).locator('.metric-value')).toHaveText('12 人');
    });

    test('R2-2: 別名不再產生「類別將改由系統班決定」的提示', async ({ page }) => {
      await page.locator('button[role="tab"]', { hasText: '班名同步' }).click();
      const panel = page.locator('[data-class-name-sync-panel]');
      await expect(panel).toBeVisible({ timeout: 10000 });
      await expect(panel).not.toContainText('類別將改由系統班決定');
    });
  });
});
