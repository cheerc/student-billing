import { test, expect, type Page } from '@playwright/test';
import { resetSeedSettings, saveSettings, reloadSettings } from './helpers/d2c-settings';

/**
 * #82：新增時段只有「班級名稱」必填，其餘（老師／星期／起迄）可留空。
 *
 * 驗收目標（issue #82 Expected Outcome 1–4）：
 *  1. 只輸入班級名稱即可點「確認新增」成功建立資料列；
 *  2. 帶班老師、星期、起迄皆可留空；
 *  3. 留空的時段列正常列出，五個計算欄平靜顯示「—」，不造成頁面阻擋報錯；
 *  4. 可儲存草稿（不阻擋）。
 *
 * 每個案例前都還原合成課表：同檔案例共用同一個 DB，#82-3／#82-4 會真的儲存，
 * 不還原的話下一個案例會看到上一個案例留下的佔位列。
 *
 * 合成資料（seed 課表），不讀 data/。
 */

/** 該班的列（含 sticky 首欄的班級名稱 input）。 */
function rowOf(page: Page, className: string) {
  return page.locator('tr.schedule-row', { has: page.locator(`input.input-classname[value="${className}"]`) });
}

/** 該列五個計算儲存格的文字（課程時長、安親×2、課輔×2）。 */
async function calcCellsText(page: Page, className: string): Promise<string[]> {
  const row = rowOf(page, className);
  const cells = row.locator('td.col-duration, td.number.cblue, td.number.cteal');
  return (await cells.allTextContents()).map((t) => t.trim());
}

/** 開「＋ 新增班級」表單，只填班級名稱後送出。 */
async function addClassNameOnly(page: Page, className: string) {
  await page.getByRole('button', { name: /＋ 新增班級|＋ 新增時段/ }).click();
  const form = page.locator('form.add-session-panel');
  await expect(form).toBeVisible();
  await form.locator('input[required]').fill(className);
  await form.getByRole('button', { name: '確認新增' }).click();
  await expect(rowOf(page, className)).toBeVisible();
}

test.describe('#82 & specs/14：新增班級僅班名必填、雙課程類型支援（A1）', () => {
  test.beforeEach(async ({ page }) => {
    await resetSeedSettings(page);
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.schedule-table')).toBeVisible();
    await expect(page.locator('.save-status-clean')).toBeVisible();
  });

  test('#82-1: 非安親課輔班新增：僅班名必填、其餘欄位預設皆空', async ({ page }) => {
    await page.getByRole('button', { name: /＋ 新增班級|＋ 新增時段/ }).click();
    const form = page.locator('form.add-session-panel');
    await expect(form).toBeVisible();

    // 表單初始狀態：課程類型預設為非安親；除了班名，其餘都應為空（不再預設週一／13:00／15:00）
    await expect(form.locator('select[aria-label="新增班級課程類型"]')).toHaveValue('non_care');
    const weekdaySelect = form.locator('select:not([aria-label="新增班級課程類型"])');
    await expect(weekdaySelect).toHaveValue('');
    await expect(form.locator('input[type="time"]').first()).toHaveValue('');
    await expect(form.locator('input[type="time"]').last()).toHaveValue('');

    // 只填班級名稱
    await form.locator('input[required]').fill('新開班-待排課');
    await form.getByRole('button', { name: '確認新增' }).click();

    // 列已建立
    const row = rowOf(page, '新開班-待排課');
    await expect(row).toHaveCount(1);
    // 星期留空（＝未定，以 placeholder 呈現）
    await expect(row.locator('input.input-weekday')).toHaveValue('');
    await expect(row.locator('input.input-weekday')).toHaveAttribute('placeholder', '未定');
    // 時間是空的
    await expect(row.locator('input.input-time').first()).toHaveValue('');
    await expect(row.locator('input.input-time').last()).toHaveValue('');
  });

  test('#82-2: 只有班級名稱是必填（班名空白時不得新增）', async ({ page }) => {
    await page.getByRole('button', { name: /＋ 新增班級|＋ 新增時段/ }).click();
    const form = page.locator('form.add-session-panel');
    await expect(form).toBeVisible();

    // 表單的 required 只掛在班級名稱那一欄
    await expect(form.locator('input[required]')).toHaveCount(1);
    await expect(form.locator('input[required]')).toHaveValue('');

    // 只有空白（沒有名稱）時按確認新增：不會建立新列
    const before = await page.locator('tr.schedule-row').count();
    await form.getByRole('button', { name: '確認新增' }).click();
    await expect(page.locator('tr.schedule-row')).toHaveCount(before);
  });

  test('#82-3: 不完整時段的五個計算欄平靜顯示「—」，不阻擋儲存（無 badge、無紅字）', async ({ page }) => {
    await addClassNameOnly(page, '新開班-待排課');

    // 五個計算欄全是「—」
    await expect.poll(() => calcCellsText(page, '新開班-待排課')).toEqual(['—', '—', '—', '—', '—']);

    // 不是「待補」badge，也沒有阻擋用的錯誤
    await expect(rowOf(page, '新開班-待排課')).not.toContainText('待補');
    await expect(page.locator('[data-schedule-import-error]')).toHaveCount(0);

    // a11y 補償：五個格子都對螢讀讀出「未設定時間」（decision d-20261004093019108435-11）
    await expect(rowOf(page, '新開班-待排課').locator('[aria-label="未設定時間"]')).toHaveCount(5);

    // 表格仍可正常儲存（不阻擋草稿）
    await expect(page.locator('.save-status-dirty')).toBeVisible();
    await saveSettings(page);
    await expect(page.locator('.save-status-clean')).toBeVisible();
  });

  test('#82-4: 儲存後 reload，佔位列仍在且計算欄仍是「—」', async ({ page }) => {
    await addClassNameOnly(page, '新開班-待排課');
    await saveSettings(page);

    await reloadSettings(page);
    await expect(rowOf(page, '新開班-待排課')).toHaveCount(1);
    expect(await calcCellsText(page, '新開班-待排課')).toEqual(['—', '—', '—', '—', '—']);
  });

  test('#82-5: 補齊星期與時間後，計算欄恢復顯示數字（不是永遠「—」）', async ({ page }) => {
    await addClassNameOnly(page, '新開班-待排課');

    // 補星期與時間：星期一 15:20–16:50（與 Gino 相同）
    const row = rowOf(page, '新開班-待排課');
    await row.locator('input.input-weekday').fill('一');
    await row.locator('input.input-time').first().fill('15:20');
    await row.locator('input.input-time').last().fill('16:50');

    // 計算欄恢復數字（不再顯示「—」）
    await expect
      .poll(async () => (await calcCellsText(page, '新開班-待排課')).join('|'), { timeout: 15000 })
      .not.toContain('—');
  });

  test('#82-6: 安親課輔班新增：選安親時不顯示時間欄位（specs/14 A1）', async ({ page }) => {
    await page.getByRole('button', { name: /＋ 新增班級|＋ 新增時段/ }).click();
    const form = page.locator('form.add-session-panel');
    await expect(form).toBeVisible();

    await form.locator('select[aria-label="新增班級課程類型"]').selectOption('care');
    await expect(form.locator('input[type="time"]')).toHaveCount(0);
    await expect(form.locator('select:not([aria-label="新增班級課程類型"])')).toHaveCount(0);
    await expect(form.locator('span.note')).toContainText('安親課輔班不需輸入上課星期與時間。');

    await form.locator('input[required]').fill('國小輔導-新安親班');
    await form.getByRole('button', { name: '確認新增' }).click();

    // 安親課輔班建立成功後自動切至安親頁籤
    await expect(page.locator('#class-type-tab-care')).toHaveAttribute('aria-selected', 'true');
    await expect(rowOf(page, '國小輔導-新安親班')).toBeVisible();
  });
});
