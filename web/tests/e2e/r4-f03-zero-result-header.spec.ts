import { test, expect } from '@playwright/test';
import { F03, ensureF03Activated } from './helpers/f03-roster';
import { openFilter, applyFilter } from './helpers/header-filter';

/**
 * R4-F03：篩選到 0 人時表頭與表頭篩選按鈕一起消失，使用者無法從面板調整條件。
 *
 * 規格依據：specs/09-ui-workflow-redesign-spec.md:151「已勾選 0 人值仍可取消且不被 prune」、
 * :162 面板操作。預期值依 helpers/f03-roster.ts 的 4 人名冊逐列手算（根 CLAUDE.md §8），
 * 不取自產品輸出。
 *
 * 本測試重現第四輪驗收 6.2A step5→6→7 的**操作形狀**：
 *   step5：年級勾 5年級、6年級 → 4 人
 *   step6：加兄弟姊妹「有」→ 1 人；再取消 6年級 → 0 人
 *   step7：0 人後重開面板取消兄弟姊妹「有」→ 恢復 2 人
 *
 * 關於「已勾選但 0 人的值是否仍顯示」：visibleFilterOptions
 * （src/lib/results-filters.ts:217）只隱藏**未勾選**的 0 人值（count !== 0 || checked），
 * 故已勾選的 6年級 在歸零後仍顯示——這正是 specs/09:151 要的行為。
 * 反之「先選 A 再勾一個當下 0 人的 B」勾不到 B，是同一條規則的另一面，非缺陷。
 */

const matched = (page: import('@playwright/test').Page) => page.locator('.counts-line [data-count="matched"]');
const gradeTrigger = (page: import('@playwright/test').Page) => page.locator('button[aria-label="年級篩選"]');

/** 6.2A step5→6：勾 5年級+6年級 → 加兄弟姊妹「有」→ 取消 6年級，歸零。 */
async function reachZeroByUnchecking(page: import('@playwright/test').Page): Promise<void> {
  await applyFilter(page, '年級', { pick: [F03.YEAR5, F03.YEAR6] });
  await expect(matched(page)).toHaveText(String(F03.BOTH_YEARS_COUNT));
  await applyFilter(page, '兄弟姊妹折扣', { pick: [F03.SIBLING_YES] });
  await expect(matched(page)).toHaveText(String(F03.BOTH_YEARS_SIBLING_COUNT));

  // 重開年級面板取消 6年級 → 交集歸零。
  const p = await openFilter(page, '年級');
  const y6 = p.locator(`[data-filter-option="${F03.YEAR6}"] input[type="checkbox"]`);
  await expect(y6).toBeChecked();
  // D46：各欄計數排除本欄、套用其他已套用條件。故此時（兄弟姊妹＝有已套用）
  //   6年級 → 列 1 → 1 人；5年級 → 無人有此標籤 → 0 人。
  // 5年級 雖為 0 人仍顯示，因它已被勾選（specs/09:151：已勾選 0 人值不得被 prune）。
  await expect(p.locator(`[data-filter-option="${F03.YEAR6}"] [data-filter-count]`)).toHaveText('1');
  await expect(p.locator(`[data-filter-option="${F03.YEAR5}"] [data-filter-count]`)).toHaveText('0');
  await y6.uncheck();
  await p.getByRole('button', { name: '確定', exact: true }).click();
  await expect(p).toHaveCount(0);

  await expect(matched(page)).toHaveText('0');
}

test.describe('R4-F03：篩選到 0 人時表頭與篩選按鈕仍可用', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await ensureF03Activated(page);
    await page.goto('/');
    await expect(page.locator('.results-table')).toBeVisible({ timeout: 15000 });
  });

  test('由取消已勾選值造成 0 人：表頭仍在，重開面板看得到已選的 0 人值並可取消', async ({ page }) => {
    await reachZeroByUnchecking(page);

    // R4-F03 的實害：0 人時表格與表頭篩選按鈕一起消失。
    await expect(page.getByText('沒有符合條件的學生')).toBeVisible();
    await expect(page.locator('.results-table thead')).toBeVisible();
    await expect(gradeTrigger(page)).toBeVisible();

    // step7：0 人後重開年級面板，已勾選的 0 人值（6年級 早已取消，此時 5年級 亦為 0）
    // 仍可見；改由兄弟姊妹面板恢復結果。
    const p = await openFilter(page, '年級');
    const y5 = p.locator(`[data-filter-option="${F03.YEAR5}"]`);
    await expect(y5.locator('input[type="checkbox"]')).toBeChecked();
    await expect(y5.locator('[data-filter-count]')).toHaveText('0');
    await page.keyboard.press('Escape');

    // 6.2A step7：開兄弟姊妹面板取消「有」→ 恢復 5年級 的 2 人。
    const s = await openFilter(page, '兄弟姊妹折扣');
    const yes = s.locator(`[data-filter-option="${F03.SIBLING_YES}"]`);
    await expect(yes.locator('input[type="checkbox"]')).toBeChecked();
    await expect(yes.locator('[data-filter-count]')).toHaveText('0');
    await yes.locator('input[type="checkbox"]').uncheck();
    await s.getByRole('button', { name: '確定', exact: true }).click();
    await expect(s).toHaveCount(0);

    await expect(matched(page)).toHaveText(String(F03.YEAR5_COUNT));
    await expect(page.locator('.results-table tbody')).toContainText('合成五年級生甲');
    await expect(gradeTrigger(page)).toBeVisible();
  });

  test('空狀態訊息與清除按鈕仍可用且文案未變', async ({ page }) => {
    await reachZeroByUnchecking(page);

    await expect(page.getByText('沒有符合條件的學生')).toBeVisible();
    await expect(page.getByText('請調整篩選條件後再試。目前的核對結果不會改變。')).toBeVisible();

    await page.getByRole('button', { name: '清除篩選條件' }).click();
    await expect(matched(page)).toHaveText(String(F03.SIZE));
  });

  test('768 與 1440 寬度下表頭可用且無整頁橫向捲動', async ({ page }) => {
    await reachZeroByUnchecking(page);

    for (const width of [768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator('.results-table thead'), `${width}px 表頭`).toBeVisible();
      await expect(gradeTrigger(page), `${width}px 篩選鈕`).toBeVisible();
      await expect(page.getByText('沒有符合條件的學生'), `${width}px 空狀態`).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow, `${width}px 出現整頁橫向捲動`).toBeLessThanOrEqual(1);
    }
  });
});