import { test, expect } from '@playwright/test';
import { openClassScheduleFull, classRows } from './helpers/c-batch';

const CLASS = '兒童美語-Gino';

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`UX120 表頭與有效數值單位 ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const row = await openClassScheduleFull(page, CLASS);
    const table = page.locator('table.schedule-table-english');
    await expect(row.locator('[data-calc="anqin-overlap"]')).toContainText('40', { timeout: 15000 });
    await page.screenshot({ path: testInfo.outputPath(`schedule-${viewport.width}.png`) });
    await expect(table.locator('thead')).toContainText('安親 (13:00–16:00)');
    await expect(table.locator('thead')).toContainText('課輔 (16:30–19:30)');
    await expect(table.locator('thead')).not.toContainText('窗口');
    await expect(table.locator('thead')).not.toContainText('／分');
    await expect(table.locator('thead')).not.toContainText('／天');
    for (const [column, value, unit] of [
      ['duration', '90', '分'], ['anqin-overlap', '40', '分'],
      ['tutoring-overlap', '20', '分'], ['anqin-deduction', '0.222', '天'],
      ['tutoring-deduction', '0.111', '天'],
    ]) {
      const cell = row.locator(`[data-calc="${column}"]`);
      await expect(cell.locator('.calc-value')).toHaveText(value);
      await expect(cell.locator('.calc-unit')).toHaveText(unit);
    }
  });

  test(`UX120 控制本體與表頭共軸 ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openClassScheduleFull(page, CLASS);
    const table = page.locator('table.schedule-table-english');
    const rows = table.locator('tbody tr.schedule-row');
    await expect(classRows(page, CLASS)).toHaveCount(3);
    await expect(rows.first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`geometry-${viewport.width}.png`) });
    for (const scrolled of [false, true]) {
      await page.locator('.schedule-table-scroll').evaluate((element, move) => {
        element.scrollLeft = move ? element.scrollWidth - element.clientWidth : 0;
      }, scrolled);
      for (const row of [rows.first(), rows.nth(1), rows.last()]) {
        for (const [column, control] of [
          ['col-skip-deduction', '.yes-no-radio-group'],
          ['col-teacher', '.input-teacher'], ['col-weekday', '.input-weekday'],
        ]) {
          const header = table.locator(`thead th.${column}`);
          const target = row.locator(`td.${column} ${control}`);
          const difference = await header.evaluate((element, targetElement) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const a = range.getBoundingClientRect();
            const b = (targetElement as Element).getBoundingClientRect();
            return Math.abs(a.x + a.width / 2 - b.x - b.width / 2);
          }, await target.elementHandle());
          expect(difference, `${column} scroll=${scrolled}`).toBeLessThanOrEqual(2);
        }
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}
