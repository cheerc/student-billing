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
  const confirmBtn = page.getByRole('button', { name: '確認變更', exact: true });
  const dialog = page.locator('dialog.impact-dialog');

  await expect(confirmBtn).toBeEnabled();
  await expect.poll(async () => {
    if (await dialog.isVisible()) return true;
    if (await confirmBtn.isEnabled()) {
      await confirmBtn.click();
    }
    return dialog.isVisible();
  }, { timeout: 10000, intervals: [100, 250, 500] }).toBe(true);

  const applied = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/settings/apply') && response.request().method() === 'POST'
  );
  await dialog.getByRole('button', { name: /儲存並更新結果|儲存課表/ }).click();
  expect((await applied).ok()).toBe(true);
  await expect(dialog).toBeHidden();
  await expect(page.locator('.save-status-clean')).toBeVisible();
}

/**
 * 課表表格中某個班級的列（#80 之後的定位慣例）。
 *
 * 以 sticky 首欄的班級名稱 input 定位，而不是以 `[data-category-select="X"]`：
 * #80 把屬性欄併入每一個時段列之後，同一班的多個時段列**各有**一份類別下拉與
 * 固定 5 天勾選（值相同），用屬性欄當錨點會解析到多個元素、觸發 Playwright
 * strict mode violation。班級名稱才是「一班一組」的穩定錨點。
 *
 * 回傳的是該班的**第一列**；要看該班全部時段請改用
 * `page.locator('tr.schedule-row', { has: page.locator(`input.input-classname[value="${className}"]`) })`。
 */
export function classRow(page: import('@playwright/test').Page, className: string) {
  return page
    .locator('tr.schedule-row', { has: page.locator(`input.input-classname[value="${className}"]`) })
    .first();
}

/** 某個班級的全部時段列（同名多列）。 */
export function classRows(page: import('@playwright/test').Page, className: string) {
  return page.locator('tr.schedule-row', {
    has: page.locator(`input.input-classname[value="${className}"]`),
  });
}
