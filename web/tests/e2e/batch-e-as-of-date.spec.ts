import { test, expect } from '@playwright/test';
import { buildB2Workbook, currentRunId, XLSX_MIME } from './helpers/b2-roster';

/** UX75：在 UI 明選不是今天的基準日，再儲存課表；不注入 server clock 或直接改 DB。 */
test('UX75：課表儲存沿用 UI 明選的基準日，歷史 run 保持不變', async ({ page }) => {
  const date = '2025-02-03';
  await page.goto('/imports');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'batch-e-date-synthetic.xlsx',
    mimeType: XLSX_MIME,
    buffer: await buildB2Workbook(),
  });
  await expect(page.locator('.stats-grid')).toBeVisible();
  await page.getByLabel('核對基準日', { exact: true }).fill(date);
  await page.getByRole('button', { name: '使用這份名單', exact: true }).click();
  await expect(page.getByText(/\d+ 位學生資料已備妥/)).toBeVisible();
  await page.goto('/');
  await expect(page.locator('.data-banner .pill')).toHaveText(`核對基準日 ${date}`);
  const oldRunId = await currentRunId(page);
  await page.getByRole('navigation', { name: '系統流程步驟' }).getByRole('link', { name: /課表設定/ }).click();
  await expect(page.locator('.schedule-table')).toBeVisible();
  const teacher = page.locator('input.input-teacher').first();
  const previous = await teacher.inputValue();
  await teacher.fill(`${previous}合成修改`);
  await page.getByRole('button', { name: '確認變更', exact: true }).click();
  const dialog = page.locator('dialog.impact-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '儲存並更新結果', exact: true }).click();
  await expect(page.locator('.savebar')).toContainText('課表已為最新儲存狀態');
  const newRunId = await currentRunId(page);
  expect(newRunId).not.toBe(oldRunId);
  await page.getByRole('navigation', { name: '系統流程步驟' }).getByRole('link', { name: /核對結果/ }).click();
  await expect(page.locator('.data-banner')).toBeVisible();
  const actual = await page.locator('.data-banner .pill').textContent();
  console.log('UX75 date', JSON.stringify({ expected: date, actual, oldRunId, newRunId }));
  expect.soft(actual, '新 run 不得擅自把明選日期換成今天').toBe(`核對基準日 ${date}`);
  await page.goto(`/history/${oldRunId}`);
  await expect(page.locator('.data-banner-history .pill')).toHaveText(`核對基準日 ${date}`);
});
