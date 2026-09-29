import { test, expect } from '@playwright/test';

/**
 * UX09（specs/04 §8）：「草稿可取消，確認才提交」。
 * 改動時段 → 出現「有未儲存的變更」→ 按「取消修改」→ 草稿還原、回到無變更狀態；
 * 重新整理後仍是原值＝沒有提交任何設定（提交只發生在「確認變更 → 儲存」之後）。
 * （改散同班名／刪列／停班的提示與後果由 tests/unit/settings-grid-rename-delete.test.ts、
 *   settings-schedule-grid-ui.test.ts 涵蓋。）
 */
test('UX09: 取消修改 → 草稿還原且沒有提交；重新整理後仍是原值', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });

  const start = () => page.locator('.schedule-table tbody tr').nth(3).locator('input.input-time').first();
  const original = await start().inputValue();
  expect(original).toMatch(/^\d{2}:\d{2}$/);

  await start().fill('15:45');
  await expect(page.locator('.save-status-dirty')).toBeVisible();

  await page.locator('button', { hasText: '取消修改' }).click();
  await expect(start()).toHaveValue(original);
  await expect(page.locator('.save-status-dirty')).toHaveCount(0);
  await expect(page.getByText('課表已為最新儲存狀態')).toBeVisible();

  // 沒有提交：重新載入後仍是原值
  await page.reload();
  await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
  await expect(start()).toHaveValue(original);
});
