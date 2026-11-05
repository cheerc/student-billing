import { test, expect, type Page } from '@playwright/test';
import { ensureB2Activated, allStudents } from './helpers/b2-roster';

/** specs/04 UX127（E2E 段）：學生總表 server 排序入網址、reload 維持、換排序回第一頁。 */
const sortButton = (page: Page, label: string) => page.locator('.results-table thead th').filter({ hasText: label }).getByRole('button', { name: new RegExp(`^${label}( [▲▼])?$`) });
const header = (page: Page, label: string) => page.locator('.results-table thead th').filter({ hasText: label });

type S = { name: string; anqinDays?: number | null };
async function firstRowDays(page: Page, students: S[]): Promise<number | null | undefined> {
  const name = await firstRowName(page);
  return students.find((s) => s.name === name)?.anqinDays;
}

async function firstRowName(page: Page): Promise<string> {
  const label = await page.locator('.results-table tbody tr').first().locator('button[aria-label^="查看 "]').getAttribute('aria-label');
  return label!.replace(/^查看 /, '').replace(/ 的明細$/, '');
}

test.beforeEach(async ({ page }) => {
  await ensureB2Activated(page);
  await page.goto('/');
  await expect(page.locator('.results-table')).toBeVisible({ timeout: 15000 });
});

test('UX127：點「安親天數」→ 網址 sort=anqinDays、第一列為最小值，reload 維持；再點為降冪', async ({ page }) => {
  const students = await allStudents(page);
  const values = students.map((s) => s.anqinDays).filter((v): v is number => typeof v === 'number');
  const min = Math.min(...values);
  const max = Math.max(...values);
  expect(min).toBeLessThan(max); // 合成名冊需有可區分的最小／最大

  await expect(page.locator('.results-table thead th[aria-sort]')).toHaveCount(0); // 預設無排序狀態
  await sortButton(page, '安親天數').click();
  await expect(page).toHaveURL(/[?&]sort=anqinDays(&|$)/);
  await expect(header(page, '安親天數')).toHaveAttribute('aria-sort', 'ascending');
  await expect.poll(() => firstRowDays(page, students)).toBe(min);

  await page.reload();
  await expect(page.locator('.results-table')).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(/[?&]sort=anqinDays(&|$)/);
  await expect(header(page, '安親天數')).toHaveAttribute('aria-sort', 'ascending');
  expect(await firstRowDays(page, students)).toBe(min);

  await sortButton(page, '安親天數').click();
  await expect(page).toHaveURL(/[?&]sort=-anqinDays(&|$)/);
  await expect(header(page, '安親天數')).toHaveAttribute('aria-sort', 'descending');
  await expect.poll(() => firstRowDays(page, students)).toBe(max);

  // 點另一欄：從升冪開始，前一欄不再有 aria-sort
  await sortButton(page, '年級').click();
  await expect(header(page, '年級')).toHaveAttribute('aria-sort', 'ascending');
  await expect(header(page, '安親天數')).not.toHaveAttribute('aria-sort', /.+/);
  await expect(page).toHaveURL(/[?&]sort=grade(&|$)/);
});
