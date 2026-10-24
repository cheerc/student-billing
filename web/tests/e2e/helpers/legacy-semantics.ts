import { expect, type Page } from '@playwright/test';

/** Approve the read-only legacy class recommendations through the product workflow. */
export async function applyLegacySemanticRecommendations(page: Page): Promise<void> {
  await page.goto('/settings');
  await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });

  const recommendation = page.locator('[data-legacy-semantic-migration]');
  if ((await recommendation.count()) === 0) return;

  await recommendation.getByRole('button', { name: '加入建議設定', exact: true }).click();
  await expect(page.locator('.save-status-dirty')).toBeVisible();
  await page.locator('.savebar').getByRole('button', { name: '確認變更', exact: true }).click();

  const dialog = page.locator('dialog.impact-dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });
  await dialog.getByRole('button', { name: '儲存並更新結果', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('.save-status-clean')).toBeVisible();
}
