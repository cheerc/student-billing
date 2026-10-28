import { test, expect, type Page } from '@playwright/test';
import { resetSeedSettings, saveSettings, reloadSettings } from './helpers/d2c-settings';

/**
 * #82 & D61 1c (UX108): 新增時段僅班名必填與未填時間雙重警示 E2E 驗收
 *
 * 驗收目標：
 *  1. 只輸入班級名稱即可點「確認新增」成功建立排課列；
 *  2. 帶班老師、星期、起訖皆可留空；
 *  3. UX108: 未填時間排課列顯示 1c 雙重警示（row-incomplete 琥珀底、input-missing 色框、待補時間徽章）；
 *  4. 支援先存檔不阻擋，重載後警示完整保留；
 *  5. 補齊星期與時間後，警示消失並恢復計算重疊與扣除。
 */

function rowOf(page: Page, className: string) {
  return page.locator('tr.schedule-row', { has: page.locator(`input.input-classname[value="${className}"]`) });
}

async function calcCellsText(page: Page, className: string): Promise<string[]> {
  const row = rowOf(page, className);
  const cells = row.locator('td.col-duration, td.number.cblue, td.number.cteal');
  return (await cells.allTextContents()).map((t) => t.trim());
}

async function addClassNameOnly(page: Page, className: string, classType: string = 'other') {
  await page.getByRole('button', { name: /＋ 新增班級|＋ 新增時段/ }).click();
  const form = page.locator('form.add-session-panel');
  await expect(form).toBeVisible();
  await form.locator('select[aria-label="新增班級課程類型"]').selectOption(classType);
  await form.locator('input[aria-label="新增班級名稱"]').fill(className);
  await form.getByRole('button', { name: '確認新增' }).click();
  await expect(rowOf(page, className)).toBeVisible();
}

test.describe('#82 & D61 1c: 新增班級僅班名必填與未填時間雙重警示 (UX108)', () => {
  test.beforeEach(async ({ page }) => {
    await resetSeedSettings(page);
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.schedule-table')).toBeVisible();
    await expect(page.locator('.save-status-clean')).toBeVisible();
  });

  test('#82-1: 排課班級新增僅班名必填、其餘欄位預設皆空', async ({ page }) => {
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const form = page.locator('form.add-session-panel');
    await expect(form).toBeVisible();

    await form.locator('select[aria-label="新增班級課程類型"]').selectOption('other');
    const weekdaySelect = form.locator('select[aria-label="新增星期"]');
    await expect(weekdaySelect).toHaveValue('');
    await expect(form.locator('input[aria-label="新增起始時間"]')).toHaveValue('');
    await expect(form.locator('input[aria-label="新增結束時間"]')).toHaveValue('');

    // 只填班級名稱
    await form.locator('input[aria-label="新增班級名稱"]').fill('新開班-待排課');
    await form.getByRole('button', { name: '確認新增' }).click();

    // 列已建立
    const row = rowOf(page, '新開班-待排課');
    await expect(row).toHaveCount(1);
    await expect(row.locator('input.input-weekday')).toHaveValue('');
    await expect(row.locator('input.input-weekday')).toHaveAttribute('placeholder', '未定');
    await expect(row.locator('input.input-time').first()).toHaveValue('');
    await expect(row.locator('input.input-time').last()).toHaveValue('');
  });

  test('#82-2: 只有班級名稱是必填（班名空白時不得新增）', async ({ page }) => {
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const form = page.locator('form.add-session-panel');
    await expect(form).toBeVisible();

    await expect(form.locator('input[required]')).toHaveCount(1);
    await expect(form.locator('input[required]')).toHaveValue('');

    const before = await page.locator('tr.schedule-row').count();
    await form.getByRole('button', { name: '確認新增' }).click();
    await expect(page.locator('tr.schedule-row')).toHaveCount(before);
  });

  test('UX108: 未填時間排課列渲染 1c 雙重警示並支援先存檔', async ({ page }) => {
    await addClassNameOnly(page, '新開班-待排課', 'other');

    const row = rowOf(page, '新開班-待排課');
    // 1. row 具有 .row-incomplete 琥珀底樣式
    await expect(row).toHaveClass(/row-incomplete/);

    // 2. 缺漏的輸入框具有 .input-missing 色框
    await expect(row.locator('input.input-weekday')).toHaveClass(/input-missing/);
    await expect(row.locator('input.input-time').first()).toHaveClass(/input-missing/);
    await expect(row.locator('input.input-time').last()).toHaveClass(/input-missing/);

    // 3. 時長格顯示醒目「待補時間」文字徽章
    await expect(row.locator('.badge-incomplete')).toHaveText('待補時間');

    // 4. 重疊與扣除欄位顯示「—」
    const cells = await calcCellsText(page, '新開班-待排課');
    expect(cells.slice(1)).toEqual(['—', '—', '—', '—']);

    // 5. 支援先存檔不阻擋
    await expect(page.locator('.save-status-dirty')).toBeVisible();
    await saveSettings(page);
    await expect(page.locator('.save-status-clean')).toBeVisible();
  });

  test('UX108: 儲存後 reload，佔位列與 1c 警示完整保留', async ({ page }) => {
    await addClassNameOnly(page, '新開班-待排課', 'other');
    await saveSettings(page);

    await reloadSettings(page);
    // 自動或切換至 [其他班] 頁籤
    await page.locator('#class-type-tab-other').click();
    const row = rowOf(page, '新開班-待排課');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveClass(/row-incomplete/);
    await expect(row.locator('.badge-incomplete')).toHaveText('待補時間');
  });

  test('UX108: 補齊星期與時間後，警示消失並恢復計算重疊分鐘與扣天', async ({ page }) => {
    await addClassNameOnly(page, '新開班-待排課', 'other');

    const row = rowOf(page, '新開班-待排課');
    await row.locator('input.input-weekday').fill('一');
    await row.locator('input.input-time').first().fill('15:20');
    await row.locator('input.input-time').last().fill('16:50');

    // 警示色框消失
    await expect(row.locator('.badge-incomplete')).toHaveCount(0);
    await expect(row).not.toHaveClass(/row-incomplete/);

    // 計算欄恢復顯示數字
    await expect
      .poll(async () => (await calcCellsText(page, '新開班-待排課')).join('|'), { timeout: 15000 })
      .not.toContain('—');
  });
});
