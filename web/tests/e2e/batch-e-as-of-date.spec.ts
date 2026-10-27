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
  const editedTeacher = `${previous}合成修改`;
  // 等待包含本次修改的計算，避免 debounce 在點擊過程中停用按鈕。
  const calculation = page.waitForResponse((response) => {
    const request = response.request();
    if (new URL(response.url()).pathname !== '/api/v1/settings/calculate' || request.method() !== 'POST') return false;
    try {
      return request.postDataJSON().draft.classes.some((item: { teacher?: string | null; slots?: { teacher?: string | null }[] }) =>
        item.teacher === editedTeacher || item.slots?.some((slot) => slot.teacher === editedTeacher));
    } catch {
      return false;
    }
  });
  await teacher.fill(editedTeacher);
  expect((await calculation).ok()).toBe(true);
  await expect(page.getByRole('button', { name: '確認變更', exact: true })).toBeEnabled();
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
