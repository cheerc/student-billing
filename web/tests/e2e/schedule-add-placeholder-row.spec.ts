import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
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
  const tab = page.locator(`#class-type-tab-${classType}`);
  if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
  await page.getByRole('button', { name: /＋ 新增班級|＋ 新增時段/ }).click();
  const form = page.locator('dialog.add-class-dialog form.add-session-panel');
  await expect(form).toBeVisible();
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
    await page.locator('#class-type-tab-other').click();
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const dialog = page.locator('dialog.add-class-dialog');
    const form = dialog.locator('form.add-session-panel');
    await expect(form).toBeVisible();

    await expect(dialog).toHaveJSProperty('open', true);
    expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(true);
    await expect(form.locator('select[aria-label="新增班級課程類型"]')).toHaveCount(0);
    await expect(form.locator('input[aria-label="新增班級名稱"]')).toBeFocused();
    const weekdaySelect = form.locator('select[aria-label="新增星期"]');
    await expect(weekdaySelect).toHaveValue('');
    await expect(weekdaySelect.locator('option')).toHaveText([
      '未定', '週一', '週二', '週三', '週四', '週五', '週六', '週日',
    ]);
    await expect(form.locator('input[aria-label="新增起始時間"]')).toHaveValue('');
    await expect(form.locator('input[aria-label="新增結束時間"]')).toHaveValue('');

    // 只填班級名稱
    await form.locator('input[aria-label="新增班級名稱"]').fill('新開班-待排課');
    await form.getByRole('button', { name: '確認新增' }).click();

    // 列已建立
    const row = rowOf(page, '新開班-待排課');
    await expect(row).toHaveCount(1);
    await expect(row.locator('select.input-weekday')).toHaveValue('');
    await expect(row.locator('input.input-time').first()).toHaveValue('');
    await expect(row.locator('input.input-time').last()).toHaveValue('');
  });

  test('#82-2: 只有班級名稱是必填（班名空白時不得新增）', async ({ page }) => {
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const form = page.locator('dialog.add-class-dialog form.add-session-panel');
    await expect(form).toBeVisible();

    await expect(form.locator('input[required]')).toHaveCount(1);
    await expect(form.locator('input[required]')).toHaveValue('');

    const before = await page.locator('tr.schedule-row').count();
    await form.getByRole('button', { name: '確認新增' }).click();
    await expect(page.locator('tr.schedule-row')).toHaveCount(before);
  });

  test('UX117: native add dialog has one selected type source, traps focus, and discards local draft on close', async ({ page }) => {
    await page.locator('#class-type-tab-english').click();
    const opener = page.getByRole('button', { name: '＋ 新增班級' });
    await opener.click();

    const dialog = page.locator('dialog.add-class-dialog');
    const name = dialog.getByLabel('新增班級名稱');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(true);
    await expect(name).toBeFocused();
    await expect(dialog.getByLabel('新增班級課程類型')).toHaveCount(0);
    await name.fill('只存在對話框的班');
    await page.keyboard.press('Tab');
    await expect(dialog.locator(':focus')).toHaveCount(1);
    await expect(page.locator('tr.schedule-row', { has: page.locator('input[value="只存在對話框的班"]') })).toHaveCount(0);

    // Native modal backdrop receives the click; the dialog stays open and does not submit.
    await page.mouse.click(2, 2);
    await expect(dialog).toBeVisible();
    await expect(page.locator('tr.schedule-row', { has: page.locator('input[value="只存在對話框的班"]') })).toHaveCount(0);

    const timePopover = dialog.locator('[data-time-popover="start"]');
    await dialog.getByRole('button', { name: '設定新增起始時間' }).click();
    await expect(timePopover).toBeVisible();
    expect(await dialog.evaluate((element) => element.contains(element.querySelector('[data-time-popover="start"]')))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(timePopover).toBeHidden();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(dialog.getByLabel('新增班級名稱')).toHaveValue('');
    await expect(dialog.getByLabel('新增星期')).toHaveValue('');
    await dialog.getByRole('button', { name: '取消新增' }).click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('UX118: paired time field exposes 24-hour sliders and commits valid endpoint pairs atomically', async ({ page }, testInfo) => {
    const rows = rowOf(page, '兒童美語-Gino');
    await page.locator('#class-type-tab-english').click();
    const row = rows.first();
    const start = row.locator('input.input-time').first();
    const end = row.locator('input.input-time').last();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await row.locator('select.input-weekday').focus();
    await page.keyboard.press('Tab');
    await expect(start).toBeFocused();
    const popover = row.locator('[data-time-popover="start"]').first();
    await expect(popover).toBeVisible();
    const hours = popover.getByRole('slider', { name: '起始時間 第 1 列 小時' });
    const minutes = popover.getByRole('slider', { name: '起始時間 第 1 列 分鐘' });
    await expect(hours).toHaveAttribute('min', '0');
    await expect(hours).toHaveAttribute('max', '23');
    await expect(hours).toHaveAttribute('step', '1');
    await expect(minutes).toHaveAttribute('min', '0');
    await expect(minutes).toHaveAttribute('max', '59');
    await expect(minutes).toHaveAttribute('step', '1');
    await hours.focus();
    await hours.press('Home');
    await expect(start).toHaveValue('00:20');
    await expect(row.locator('[data-pending-time-error]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    await end.click();
    const endPopover = row.locator('[data-time-popover="end"]').first();
    const endHours = endPopover.getByRole('slider', { name: '結束時間 第 1 列 小時' });
    await expect(endPopover).toBeVisible();
    const endHoursBox = await endHours.boundingBox();
    if (!endHoursBox) throw new Error('End-hour slider has no browser geometry');
    const sliderY = endHoursBox.y + endHoursBox.height / 2;
    await page.mouse.move(endHoursBox.x + endHoursBox.width * (16 / 23), sliderY);
    await page.mouse.down();
    await page.mouse.move(endHoursBox.x + endHoursBox.width - 1, sliderY);
    await expect(row.locator('[data-pending-time-error]')).toBeVisible();
    await expect(page.locator('[data-schedule-export]')).toBeDisabled();
    await expect(end).toHaveValue('16:50');
    await page.mouse.up();
    await expect(end).toHaveValue('23:50');
    await expect(row.locator('[data-pending-time-error]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // A cancelled pointer interaction must settle its latest preview before blur/dismissal.
    await end.fill('16:50');
    await end.click();
    const cancelPopover = row.locator('[data-time-popover="end"]').first();
    const cancelHours = cancelPopover.getByRole('slider', { name: '結束時間 第 1 列 小時' });
    const cancelBox = await cancelHours.boundingBox();
    if (!cancelBox) throw new Error('End-hour slider has no browser geometry');
    const cancelY = cancelBox.y + cancelBox.height / 2;
    await page.mouse.move(cancelBox.x + cancelBox.width * (16 / 23), cancelY);
    await page.mouse.down();
    await page.mouse.move(cancelBox.x + cancelBox.width * (20 / 23), cancelY);
    await expect(row.locator('[data-pending-time-error]')).toBeVisible();
    const previewValue = await cancelPopover.locator('.time-field24-preview').textContent();
    if (!previewValue) throw new Error('End-hour preview did not render a value');
    await cancelHours.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true });
    await expect(end).toHaveValue(previewValue);
    await expect(row.locator('[data-pending-time-error]')).toHaveCount(0);
    await page.mouse.up();
    await page.keyboard.press('Escape');

    await start.fill('00:00');
    await end.fill('23:59');
    await expect(start).toHaveValue('00:00');
    await expect(end).toHaveValue('23:59');
    await expect(row.locator('[data-pending-time-error]')).toHaveCount(0);

    await start.fill('24:00');
    await expect(row.locator('[data-pending-time-error]')).toBeVisible();
    await expect(start).toHaveValue('24:00');
    await expect(end).toHaveValue('23:59');
    await start.fill('00:00');
    await expect(row.locator('[data-pending-time-error]')).toHaveCount(0);

    await end.fill('00:00');
    await expect(row.locator('[data-pending-time-error]')).toBeVisible();
    await expect(start).toHaveValue('00:00');
    await expect(end).toHaveValue('00:00');
    await end.fill('23:59');
    await expect(row.locator('[data-pending-time-error]')).toHaveCount(0);

    // Keep manual entry and the popup fully in view at both target sizes.
    const mobile = { width: 390, height: 844 };
    await page.setViewportSize(mobile);
    await start.fill('08:30');
    await end.fill('08:45');
    await expect(start).toHaveValue('08:30');
    await expect(end).toHaveValue('08:45');

    const geometry: Record<string, { left: number; top: number; right: number; bottom: number; width: number; height: number; hit: boolean }> = {};
    for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', ...mobile }]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await start.click();
      await expect(popover).toBeVisible();
      const measured = await popover.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: window.innerWidth,
          height: window.innerHeight,
          hit: target === element || element.contains(target),
        };
      });
      geometry[viewport.name] = measured;
      expect(measured.left).toBeGreaterThanOrEqual(0);
      expect(measured.top).toBeGreaterThanOrEqual(0);
      expect(measured.right).toBeLessThanOrEqual(viewport.width);
      expect(measured.bottom).toBeLessThanOrEqual(viewport.height);
      expect(measured.hit).toBe(true);
      await testInfo.attach(`time-popover-${viewport.name}.png`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      await page.screenshot({ path: testInfo.outputPath(`time-popover-${viewport.name}.png`) });
      await page.mouse.click(2, 2);
      await expect(popover).toBeHidden();
    }
    await writeFile(testInfo.outputPath('time-popover-geometry.json'), JSON.stringify(geometry, null, 2));
    await testInfo.attach('time-popover-geometry.json', {
      body: Buffer.from(JSON.stringify(geometry, null, 2)),
      contentType: 'application/json',
    });
    expect(pageErrors).toEqual([]);
  });

  test('UX108: 未填時間排課列渲染 1c 雙重警示並支援先存檔', async ({ page }) => {
    await addClassNameOnly(page, '新開班-待排課', 'other');

    const row = rowOf(page, '新開班-待排課');
    // 1. row 具有 .row-incomplete 琥珀底樣式
    await expect(row).toHaveClass(/row-incomplete/);

    // 2. 缺漏的輸入框具有 .input-missing 色框
    await expect(row.locator('select.input-weekday')).toHaveClass(/input-missing/);
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
    await row.locator('select.input-weekday').selectOption('一');
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
    const classSnapshots: Array<Record<string, unknown> & { sessions?: unknown[] }> = [];
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
    const form = page.locator('dialog.add-class-dialog form.add-session-panel');
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
    const form = page.locator('dialog.add-class-dialog form.add-session-panel');
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
    const form = page.locator('dialog.add-class-dialog form.add-session-panel');
    await form.locator('input[aria-label="新增班級名稱"]').fill(className);
    await form.getByRole('button', { name: '確認新增' }).click();

    const conflict = page.getByRole('alert').filter({ hasText: className });
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText(/類型|設定|衝突/);
    await expect(page.getByLabel('新增班級名稱')).toHaveValue(className);
    await expect(classRows(page, className)).toHaveCount(0);

    await page.locator('dialog.add-class-dialog').getByRole('button', { name: '取消新增' }).click();
    await page.locator('#class-type-tab-english').click();
    await expect(classRows(page, className)).toHaveCount(3);
    await expect(page.getByRole('radiogroup', { name: `${className} 的是否有多科折扣` }).first()
      .locator('input[value="false"]')).toBeChecked();
  });
});
