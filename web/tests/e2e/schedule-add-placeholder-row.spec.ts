import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resetSeedSettings, saveSettings, reloadSettings, setMultiDiscount } from './helpers/d2c-settings';
import { calcCell, classRows, openClassScheduleFull } from './helpers/c-batch';

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
    const submit = dialog.getByRole('button', { name: '確認新增' });
    await submit.focus();
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expect(dialog.getByRole('button', { name: '關閉新增視窗' })).toBeFocused();
    await expect(page.locator('tr.schedule-row', { has: page.locator('input[value="只存在對話框的班"]') })).toHaveCount(0);

    // Native modal backdrop receives the click; the dialog stays open and does not submit.
    await page.mouse.click(2, 2);
    await expect(dialog).toBeVisible();
    await expect(page.locator('tr.schedule-row', { has: page.locator('input[value="只存在對話框的班"]') })).toHaveCount(0);

    const timePopover = dialog.locator('[data-time-popover="start"]');
    await dialog.getByRole('button', { name: '設定新增起始時間' }).click();
    await expect(timePopover).toBeVisible();
    expect(await dialog.evaluate((element) => element.contains(element.querySelector('[data-time-popover="start"]')))).toBe(true);
    const overlayHit = await timePopover.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        hit: hit === element || element.contains(hit),
      };
    });
    expect(overlayHit.left).toBeGreaterThanOrEqual(0);
    expect(overlayHit.top).toBeGreaterThanOrEqual(0);
    expect(overlayHit.right).toBeLessThanOrEqual(1440);
    expect(overlayHit.bottom).toBeLessThanOrEqual(900);
    expect(overlayHit.hit).toBe(true);
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

  test('UX117: all five class tabs supply the field matrix and defaults; X and successful add restore focus without losing page edits', async ({ page }) => {
    const matrix: Array<{
      type: 'care' | 'english' | 'math' | 'other' | 'unscheduled';
      multi: boolean;
      fixed: boolean;
      schedulable: boolean;
      skip: boolean;
      multiDefault?: boolean;
      fixedDefault?: boolean;
      skipDefault?: boolean;
    }> = [
      { type: 'care', multi: true, fixed: true, schedulable: false, skip: false, multiDefault: true, fixedDefault: false },
      { type: 'english', multi: true, fixed: false, schedulable: true, skip: true, multiDefault: true },
      { type: 'math', multi: true, fixed: false, schedulable: true, skip: true, multiDefault: true },
      { type: 'other', multi: false, fixed: false, schedulable: true, skip: true, skipDefault: true },
      { type: 'unscheduled', multi: false, fixed: false, schedulable: false, skip: false },
    ] as const;

    for (const item of matrix) {
      await page.locator(`#class-type-tab-${item.type}`).click();
      const opener = page.getByRole('button', { name: /新增班級|新增時段/ });
      await opener.click();
      const dialog = page.locator('dialog.add-class-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', { name: `新增${({ care: '安親課輔班', english: '美語班', math: '數學班', other: '其他班', unscheduled: '不排課' } as const)[item.type]}` })).toBeVisible();
      await expect(dialog.getByLabel('新增班級名稱')).toBeFocused();
      await expect(dialog.getByLabel('新增班級名稱')).toHaveAttribute('required', '');
      await expect(dialog.getByRole('combobox', { name: '新增班級課程類型' })).toHaveCount(0);

      const multi = dialog.getByRole('radiogroup', { name: '新增班級是否有多科折扣' });
      await expect(multi).toHaveCount(item.multi ? 1 : 0);
      if (item.multi) {
        await expect(multi.locator('input[value="true"]')).toBeChecked({ checked: item.multiDefault });
        await expect(multi.locator('input[value="false"]')).toBeChecked({ checked: !item.multiDefault });
      }
      const fixed = dialog.getByRole('radiogroup', { name: '新增班級天數固定5天' });
      await expect(fixed).toHaveCount(item.fixed ? 1 : 0);
      if (item.fixed) {
        await expect(fixed.locator(`input[value="${item.fixedDefault}"]`)).toBeChecked();
        await expect(fixed.locator(`input[value="${!item.fixedDefault}"]`)).not.toBeChecked();
      }

      const skip = dialog.getByRole('radiogroup', { name: '新增時段不計扣天' });
      await expect(skip).toHaveCount(item.skip ? 1 : 0);
      if (item.skip) {
        await expect(skip.locator('input[value="true"]')).toBeChecked({ checked: item.skipDefault ?? false });
      }
      await expect(dialog.getByLabel('新增星期')).toHaveCount(item.schedulable ? 1 : 0);
      await expect(dialog.getByRole('textbox', { name: '新增起始時間' })).toHaveCount(item.schedulable ? 1 : 0);
      await expect(dialog.getByRole('textbox', { name: '新增結束時間' })).toHaveCount(item.schedulable ? 1 : 0);

      await dialog.getByRole('button', { name: '取消新增' }).click();
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
    }

    await page.locator('#class-type-tab-english').click();
    await setMultiDiscount(page, '兒童美語-Gino', false);
    await expect(page.locator('.save-status-dirty')).toBeVisible();
    const opener = page.getByRole('button', { name: /新增班級|新增時段/ });
    const existingRows = classRows(page, '兒童美語-Gino');
    await opener.click();
    const dialog = page.locator('dialog.add-class-dialog');
    await dialog.getByLabel('新增班級名稱').fill('X 關閉不建立');
    await dialog.getByRole('button', { name: '關閉新增視窗' }).click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(existingRows).toHaveCount(3);
    await expect(page.getByRole('radiogroup', { name: '兒童美語-Gino 的是否有多科折扣' }).first()
      .locator('input[value="false"]')).toBeChecked();
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    await opener.click();
    await expect(dialog.getByLabel('新增班級名稱')).toHaveValue('');
    await dialog.getByLabel('新增班級名稱').fill('成功新增回焦點');
    await dialog.getByRole('button', { name: '確認新增' }).click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(classRows(page, '成功新增回焦點')).toHaveCount(1);
    await expect(page.locator('.save-status-dirty')).toBeVisible();
    await page.getByRole('button', { name: '取消修改' }).click();
    await expect(classRows(page, '成功新增回焦點')).toHaveCount(0);
    await expect(page.locator('.save-status-clean')).toBeVisible();
  });

  test('UX117: long add dialog scrolls its content while keeping actions usable on a short viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 320 });
    await page.locator('#class-type-tab-math').click();
    await page.getByRole('button', { name: /新增班級|新增時段/ }).click();
    const dialog = page.locator('dialog.add-class-dialog');
    await expect(dialog).toBeVisible();
    const geometry = await dialog.evaluate((element) => {
      const dialogRect = element.getBoundingClientRect();
      const footer = element.querySelector('.dialogfooter')!;
      const footerRect = footer.getBoundingClientRect();
      const scrollable = Array.from(element.querySelectorAll<HTMLElement>('*')).find((node) => {
        const overflowY = window.getComputedStyle(node).overflowY;
        return (overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight;
      });
      if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
      return {
        dialog: { top: dialogRect.top, bottom: dialogRect.bottom },
        scroll: scrollable && {
          clientHeight: scrollable.clientHeight,
          scrollHeight: scrollable.scrollHeight,
          scrollTop: scrollable.scrollTop,
        },
        footer: { top: footerRect.top, bottom: footerRect.bottom },
        viewportHeight: window.innerHeight,
      };
    });
    expect(geometry.dialog.top).toBeGreaterThanOrEqual(0);
    expect(geometry.dialog.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
    expect(geometry.scroll).not.toBeNull();
    expect(geometry.scroll!.scrollHeight).toBeGreaterThan(geometry.scroll!.clientHeight);
    expect(geometry.scroll!.scrollTop).toBeGreaterThan(0);
    const confirm = dialog.getByRole('button', { name: '確認新增' });
    await expect(confirm).toBeVisible();
    const confirmReachable = await confirm.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return target === button || button.contains(target);
    });
    expect(confirmReachable).toBe(true);
    expect(geometry.footer.top).toBeGreaterThanOrEqual(0);
    expect(geometry.footer.bottom).toBeLessThanOrEqual(320);
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
    await hours.focus();
    await expect(hours).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(start).toBeFocused();

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
    await expect(page.getByRole('button', { name: '確認變更' })).toBeDisabled();
    await expect(end).toHaveValue('16:50');
    await page.mouse.up();
    await expect(end).toHaveValue('23:50');
    await expect(row.locator('[data-pending-time-error]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Escape while a real pointer preview is still dirty must commit before dismissal.
    await end.fill('16:50');
    const escapePopover = row.locator('[data-time-popover="end"]').first();
    const escapeHours = escapePopover.getByRole('slider', { name: '結束時間 第 1 列 小時' });
    const escapeBox = await escapeHours.boundingBox();
    if (!escapeBox) throw new Error('End-hour slider has no browser geometry');
    const escapeY = escapeBox.y + escapeBox.height / 2;
    await page.mouse.move(escapeBox.x + escapeBox.width * (16 / 23), escapeY);
    await page.mouse.down();
    await page.mouse.move(escapeBox.x + escapeBox.width - 1, escapeY);
    await expect(row.locator('[data-pending-time-error]')).toBeVisible();
    const escapePreview = await escapePopover.locator('.time-field24-preview').textContent();
    if (!escapePreview) throw new Error('End-hour preview did not render a value');
    await page.keyboard.press('Escape');
    await expect(escapePopover).toBeHidden();
    await expect(end).toHaveValue(escapePreview);
    await expect(row.locator('[data-pending-time-error]')).toHaveCount(0);
    await page.mouse.up();

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

    await page.setViewportSize(mobile);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const pageScrollBefore = await page.evaluate(() => window.scrollY);
    const scroller = page.locator('.schedule-table-scroll');
    const edgeRow = page.locator('.schedule-table-english tbody tr.schedule-row').last();
    const edgeStart = edgeRow.locator('input.input-time').first();
    const scrollBefore = await scroller.evaluate((element) => {
      const maxLeft = element.scrollWidth - element.clientWidth;
      const maxTop = element.scrollHeight - element.clientHeight;
      element.scrollTop = maxTop;
      const rows = element.querySelectorAll('tbody tr.schedule-row');
      const input = rows.item(rows.length - 1)?.querySelector('input.input-time');
      if (!input) throw new Error('Scrollable schedule table has no last-row time input');
      const inputRect = input.getBoundingClientRect();
      element.scrollLeft = Math.min(maxLeft, Math.max(0, element.scrollLeft + inputRect.right - window.innerWidth + 12));
      return { maxLeft, maxTop, scrollLeft: element.scrollLeft, scrollTop: element.scrollTop };
    });
    expect(scrollBefore.maxLeft).toBeGreaterThan(0);
    expect(scrollBefore.maxTop).toBeGreaterThan(0);
    await expect(edgeStart).toBeVisible();
    const scrolledPopover = edgeRow.locator('[data-time-popover="start"]');
    await edgeStart.click();
    await expect(scrolledPopover).toBeVisible();
    const scrolledGeometry = await scrolledPopover.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: window.innerWidth,
        height: window.innerHeight,
        hit: hit === element || element.contains(hit),
      };
    });
    expect(scrolledGeometry.left).toBeGreaterThanOrEqual(0);
    expect(scrolledGeometry.top).toBeGreaterThanOrEqual(0);
    expect(scrolledGeometry.right).toBeLessThanOrEqual(mobile.width);
    expect(scrolledGeometry.bottom).toBeLessThanOrEqual(mobile.height);
    expect(scrolledGeometry.hit).toBe(true);
    const scrollWhileOpen = await scroller.evaluate((element) => ({ scrollLeft: element.scrollLeft, scrollTop: element.scrollTop }));
    expect(scrollWhileOpen).toEqual({ scrollLeft: scrollBefore.scrollLeft, scrollTop: scrollBefore.scrollTop });
    await page.keyboard.press('Escape');
    await expect(scrolledPopover).toBeHidden();
    const scrollAfter = await scroller.evaluate((element) => ({ scrollLeft: element.scrollLeft, scrollTop: element.scrollTop }));
    expect(scrollAfter).toEqual(scrollWhileOpen);
    await expect(edgeStart).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollBefore);
    geometry['scrolled-table-mobile'] = scrolledGeometry;
    await writeFile(testInfo.outputPath('time-popover-geometry.json'), JSON.stringify(geometry, null, 2));
    await testInfo.attach('time-popover-geometry.json', {
      body: Buffer.from(JSON.stringify(geometry, null, 2)),
      contentType: 'application/json',
    });
    expect(pageErrors).toEqual([]);
  });

  test('UX119: equal-time pending masks prior calculation and blocks apply/export until the valid pair returns', async ({ page }) => {
    const row = await openClassScheduleFull(page, '兒童美語-Gino');
    const calcColumns = ['anqin-overlap', 'anqin-deduction', 'tutoring-overlap', 'tutoring-deduction'] as const;
    const cell = (name: (typeof calcColumns)[number]) => calcCell(page, '兒童美語-Gino', name);
    const start = row.locator('input.input-time').first();
    const end = row.locator('input.input-time').last();
    await expect(start).toHaveValue('15:20');
    await expect(end).toHaveValue('16:50');
    await expect(calcCell(page, '兒童美語-Gino', 'anqin-overlap')).toHaveText('40', { timeout: 10000 });
    await expect(calcCell(page, '兒童美語-Gino', 'tutoring-overlap')).toHaveText('20');
    let calculateRequests = 0;
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/settings/calculate') && request.method() === 'POST') calculateRequests += 1;
    });
    await page.clock.install();
    const assertPendingBoundary = async () => {
      await expect(row.locator('[data-pending-time-error]')).toBeVisible();
      for (const column of calcColumns) await expect(cell(column)).toHaveText('—');
      await expect(page.getByRole('button', { name: '確認變更' })).toBeDisabled();
      await expect(page.locator('[data-schedule-export]')).toBeDisabled();
    };
    const requestsBeforePending = calculateRequests;

    await start.fill('16:50');
    await expect(start).toHaveValue('16:50');
    await expect(end).toHaveValue('16:50');
    await assertPendingBoundary();
    await page.clock.fastForward(500);
    expect(calculateRequests).toBe(requestsBeforePending);

    await start.fill('15:20');
    await expect(row.locator('[data-pending-time-error]')).toHaveCount(0);
    const restoredRequest = page.waitForRequest((request) =>
      request.url().includes('/api/v1/settings/calculate') && request.method() === 'POST'
    );
    await page.clock.fastForward(500);
    await restoredRequest;
    await expect(cell('anqin-overlap')).toHaveText('40', { timeout: 10000 });
    await expect(cell('tutoring-overlap')).toHaveText('20');

    const requestsBeforeInverted = calculateRequests;
    await start.fill('17:00');
    await expect(start).toHaveValue('17:00');
    await expect(end).toHaveValue('16:50');
    await assertPendingBoundary();
    await page.clock.fastForward(500);
    expect(calculateRequests).toBe(requestsBeforeInverted);

    await start.fill('15:20');
    await expect(row.locator('[data-pending-time-error]')).toHaveCount(0);
    await expect(cell('anqin-overlap')).toHaveText('40', { timeout: 10000 });
    await expect(cell('tutoring-overlap')).toHaveText('20');
  });

  test('UX119: slider preview does not recalculate on pointer moves and commits once on release', async ({ page }) => {
    const row = await openClassScheduleFull(page, '兒童美語-Gino');
    const end = row.locator('input.input-time').last();
    let calculateRequests = 0;
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/settings/calculate') && request.method() === 'POST') calculateRequests += 1;
    });

    await end.click();
    const popover = row.locator('[data-time-popover="end"]');
    const hours = popover.getByRole('slider', { name: '結束時間 第 1 列 小時' });
    const box = await hours.boundingBox();
    if (!box) throw new Error('End-hour slider has no browser geometry');
    await page.clock.install();
    const before = calculateRequests;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * (16 / 23), y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * (18 / 23), y);
    await page.mouse.move(box.x + box.width * (20 / 23), y);
    await expect(row.locator('[data-pending-time-error]')).toBeVisible();
    await page.clock.fastForward(500);
    expect(calculateRequests).toBe(before);
    const preview = await popover.locator('.time-field24-preview').textContent();
    if (!preview) throw new Error('Held pointer preview did not render a value');

    const committedRequest = page.waitForRequest((request) =>
      request.url().includes('/api/v1/settings/calculate') && request.method() === 'POST'
    );
    await page.mouse.up();
    await page.clock.fastForward(250);
    await committedRequest;
    expect(calculateRequests).toBe(before + 1);
    await expect(end).toHaveValue(preview);
    await expect(row.locator('[data-pending-time-error]')).toHaveCount(0);
  });

  test('UX119: touch slider completion commits the selected hour on a touch-enabled Chromium page', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const touchPage = await context.newPage();
    try {
      await resetSeedSettings(touchPage);
      await touchPage.goto('/settings');
      await expect(touchPage.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
      await touchPage.locator('#class-type-tab-english').click();
      const row = classRows(touchPage, '兒童美語-Gino').first();
      const end = row.locator('input.input-time').last();
      await end.click();
      const popover = row.locator('[data-time-popover="end"]');
      await expect(popover).toBeVisible();
      const hours = popover.getByRole('slider', { name: '結束時間 第 1 列 小時' });
      const box = await hours.boundingBox();
      if (!box) throw new Error('Touch end-hour slider has no browser geometry');
      await touchPage.touchscreen.tap(box.x + box.width * (18 / 23), box.y + box.height / 2);
      await expect.poll(() => end.inputValue()).not.toBe('16:50');
      const preview = await popover.locator('.time-field24-preview').textContent();
      if (!preview) throw new Error('Touch preview did not render a value');
      await expect(end).toHaveValue(preview);
      await expect(row.locator('[data-pending-time-error]')).toHaveCount(0);
    } finally {
      await context.close();
    }
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

  test('UX119: one blank endpoint is legal and survives save/reload without pending error', async ({ page }) => {
    await page.locator('#class-type-tab-english').click();
    const className = 'PR2 單端空白測試班';
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const form = page.locator('dialog.add-class-dialog form.add-session-panel');
    await form.getByLabel('新增班級名稱').fill(className);
    await form.getByLabel('新增星期').selectOption('一');
    await form.getByRole('textbox', { name: '新增起始時間' }).fill('15:20');
    await form.getByRole('textbox', { name: '新增結束時間' }).fill('16:50');
    await form.getByRole('button', { name: '確認新增' }).click();
    const row = classRows(page, className).first();
    const start = row.locator('input.input-time').first();
    const end = row.locator('input.input-time').last();
    const originalEnd = await end.inputValue();
    await start.fill('');
    await expect(start).toHaveValue('');
    await expect(end).toHaveValue(originalEnd);
    await expect(row.locator('[data-pending-time-error]')).toHaveCount(0);
    await expect(row).toHaveClass(/row-incomplete/);
    await saveSettings(page);
    await reloadSettings(page);
    await page.locator('#class-type-tab-english').click();
    const reloaded = classRows(page, className).first();
    await expect(reloaded.locator('input.input-time').first()).toHaveValue('');
    await expect(reloaded.locator('input.input-time').last()).toHaveValue(originalEnd);
    await expect(reloaded.locator('[data-pending-time-error]')).toHaveCount(0);
    await expect(reloaded).toHaveClass(/row-incomplete/);
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

  test('Issue #213: 同名安親班的固定 5 天屬性衝突在新增前拒絕且保留原值', async ({ page }) => {
    const className = '國小輔導-四年級';
    await openClassScheduleFull(page, className);
    await page.locator('#class-type-tab-care').click();
    const fixed = page.getByRole('radiogroup', { name: `${className} 的天數固定 5 天` });
    await fixed.locator('label', { hasText: '是' }).click();
    await expect(fixed.locator('input[value="true"]')).toBeChecked();

    await page.getByRole('button', { name: /新增班級|新增時段/ }).click();
    const dialog = page.locator('dialog.add-class-dialog');
    const draftFixed = dialog.getByRole('radiogroup', { name: '新增班級天數固定5天' });
    await expect(draftFixed.locator('input[value="false"]')).toBeChecked();
    await dialog.getByLabel('新增班級名稱').fill(className);
    await dialog.getByRole('button', { name: '確認新增' }).click();

    const conflict = dialog.getByRole('alert');
    await expect(conflict).toContainText(/固定 5 天/);
    await expect(classRows(page, className)).toHaveCount(1);
    await expect(fixed.locator('input[value="true"]')).toBeChecked();
  });
});
