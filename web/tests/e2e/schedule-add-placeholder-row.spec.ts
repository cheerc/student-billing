import { test, expect, type Page } from '@playwright/test';
import { resetSeedSettings, saveSettings, reloadSettings, setMultiDiscount } from './helpers/d2c-settings';
import { classRows, openClassScheduleFull } from './helpers/c-batch';

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

  test('Issue #213: 同類型同屬性仍允許同名多時段', async ({ page }) => {
    const className = '兒童美語-Gino';
    const classSnapshots: Array<Record<string, unknown>> = [];
    page.on('request', (request) => {
      if (!request.url().includes('/api/v1/settings/calculate') || request.method() !== 'POST') return;
      const body = request.postData();
      if (!body) return;
      try {
        const payload = JSON.parse(body) as { draft?: { classes?: Array<Record<string, unknown>> } };
        const item = payload.draft?.classes?.find((candidate) => candidate.baseName === className);
        if (item) classSnapshots.push(item);
      } catch {
        // Ignore unrelated malformed request bodies; this listener only records the settings draft.
      }
    });

    await openClassScheduleFull(page, className);
    await page.locator('#class-type-tab-english').click();
    await expect(classRows(page, className)).toHaveCount(3);
    await expect.poll(() => classSnapshots.length).toBeGreaterThan(0);
    const originalAttributes = classSnapshots.at(-1)!;
    expect(originalAttributes.classType).toBe('english');
    expect(originalAttributes.hasMultiSubjectDiscount).toBe(true);

    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const form = page.locator('form.add-session-panel');
    await form.locator('select[aria-label="新增班級課程類型"]').selectOption('english');
    await form.locator('input[aria-label="新增班級名稱"]').fill(className);
    await form.getByRole('button', { name: '確認新增' }).click();

    await expect(classRows(page, className)).toHaveCount(4);
    await expect.poll(() => classSnapshots.at(-1)?.sessions?.length).toBe(4);
    const updatedAttributes = classSnapshots.at(-1)!;
    for (const key of ['classType', 'hasMultiSubjectDiscount', 'category', 'categorySource', 'fixedFiveDays']) {
      expect(updatedAttributes[key], `${key} must be preserved when adding a same-attribute session`).toEqual(
        originalAttributes[key]
      );
      expect(Object.prototype.hasOwnProperty.call(updatedAttributes, key)).toBe(
        Object.prototype.hasOwnProperty.call(originalAttributes, key)
      );
    }
  });

  test('Issue #213: 同類型但多科折扣不同的同名新增被拒絕', async ({ page }) => {
    const className = '兒童美語-Gino';
    await openClassScheduleFull(page, className);
    await page.locator('#class-type-tab-english').click();
    await expect(classRows(page, className)).toHaveCount(3);
    await setMultiDiscount(page, className, false);

    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const form = page.locator('form.add-session-panel');
    await form.locator('select[aria-label="新增班級課程類型"]').selectOption('english');
    await form.locator('input[aria-label="新增班級名稱"]').fill(className);
    await form.getByRole('button', { name: '確認新增' }).click();

    const conflict = page.getByRole('alert').filter({ hasText: className });
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText(/折扣|設定|衝突/);
    await expect(page.getByLabel('新增班級名稱')).toHaveValue(className);
    await expect(classRows(page, className)).toHaveCount(3);
    await expect(page.getByRole('radiogroup', { name: `${className} 的是否有多科折扣` }).first()
      .locator('input[value="false"]')).toBeChecked();
  });

  test('Issue #213: 不同類型與多科折扣衝突的同名新增被拒絕且原列不變', async ({ page }) => {
    const className = '兒童美語-Gino';
    await openClassScheduleFull(page, className);
    await page.locator('#class-type-tab-english').click();
    await expect(classRows(page, className)).toHaveCount(3);

    // 特徵化既有 English=false 與 Add 預設=true 的衝突；teacher/time/skip 均是列層級。
    await setMultiDiscount(page, className, false);
    await page.locator('#class-type-tab-care').click();
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const form = page.locator('form.add-session-panel');
    await form.locator('select[aria-label="新增班級課程類型"]').selectOption('care');
    await form.locator('input[aria-label="新增班級名稱"]').fill(className);
    await form.getByRole('button', { name: '確認新增' }).click();

    const conflict = page.getByRole('alert').filter({ hasText: className });
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText(/類型|設定|衝突/);
    await expect(page.getByLabel('新增班級名稱')).toHaveValue(className);
    await expect(classRows(page, className)).toHaveCount(0);

    await page.getByRole('button', { name: /取消新增|取消/ }).click();
    await page.locator('#class-type-tab-english').click();
    await expect(classRows(page, className)).toHaveCount(3);
    await expect(page.getByRole('radiogroup', { name: `${className} 的是否有多科折扣` }).first()
      .locator('input[value="false"]')).toBeChecked();
  });
});
