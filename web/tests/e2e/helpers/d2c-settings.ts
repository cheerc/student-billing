import { expect, type Page } from '@playwright/test';
import { buildSeedDraft } from '../../../src/adapters/sqlite/settings-repository';

/** 只透過正式 preview／apply 與 revision CAS 還原合成課表，不讀寫 DB 檔。 */
export async function resetSeedSettings(page: Page): Promise<void> {
  const current = await page.request.get('/api/v1/runs/current');
  expect(current.ok()).toBe(true);
  const { revision } = await current.json();
  const preview = await page.request.post('/api/v1/settings/preview', {
    data: { draft: buildSeedDraft(), expectedRevision: revision },
  });
  expect(preview.ok()).toBe(true);
  const { previewId } = await preview.json();
  const apply = await page.request.post('/api/v1/settings/apply', {
    data: { previewId, expectedRevision: revision, idempotencyKey: `d2c-reset-${previewId}` },
  });
  expect(apply.ok()).toBe(true);
}

/** calculate 由 client effect 發出；等其回應，避免在 SSR 畫面尚未 hydration 時批次派發事件。 */
export async function reloadSettings(page: Page): Promise<void> {
  const calculated = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/settings/calculate') && response.request().method() === 'POST'
  );
  await page.reload();
  expect((await calculated).ok()).toBe(true);
  await expect(page.locator('.save-status-clean')).toBeVisible();
}

/** 等本次 apply 成功、dialog 關閉與 dirty 清除；toast 不能識別是哪次儲存。 */
export async function saveSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '確認變更', exact: true }).click();
  const dialog = page.locator('dialog.impact-dialog');
  await expect(dialog).toBeVisible();
  const applied = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/settings/apply') && response.request().method() === 'POST'
  );
  await dialog.getByRole('button', { name: /儲存並更新結果|儲存課表/ }).click();
  expect((await applied).ok()).toBe(true);
  await expect(dialog).toBeHidden();
  await expect(page.locator('.save-status-clean')).toBeVisible();
}
