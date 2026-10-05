import { test, expect, type Page } from '@playwright/test';
import path from 'path';

/**
 * issue #96 R6-F02：核對結果頁學生總表的姓名表頭被資料列蓋住。
 *
 * 姓名欄本身仍固定在左緣（那部分沒壞），壞的是**表頭**被後面的 sticky 資料格
 * 畫上去。本檔直接以 `elementFromPoint` 斷言姓名 `th` 的中心點命中自己，
 * 不量間距——間距正確但堆疊順序錯誤正是本缺陷的形態。
 */

const FIXTURE = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');

async function ensureFixtureActivated(page: Page) {
  await page.goto('/');
  if ((await page.locator('.data-banner-current').count()) > 0) return;
  await page.goto('/imports');
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 20000 });
  await page.locator('button', { hasText: '使用這份名單' }).click();
  await expect(page.getByText(/\d+ 位學生資料已備妥/)).toBeVisible({ timeout: 20000 });
}

interface HeaderProbe {
  point: { x: number; y: number };
  hitTag: string | null;
  hitClass: string | null;
  hitText: string;
  hitsHeader: boolean;
  headerRect: { x: number; y: number; width: number; height: number };
}

async function probeNameHeader(page: Page): Promise<HeaderProbe> {
  return page.evaluate(() => {
    const table = document.querySelector('.results-table');
    const header = table?.querySelector('thead th.sticky-name') as HTMLElement | null;
    if (!header) throw new Error('找不到學生總表姓名表頭');
    const rect = header.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      point: { x: +x.toFixed(1), y: +y.toFixed(1) },
      hitTag: hit?.tagName ?? null,
      hitClass: typeof hit?.className === 'string' ? hit.className : null,
      hitText: (hit?.textContent ?? '').trim().slice(0, 12),
      hitsHeader: hit === header || (!!hit && header.contains(hit)),
      headerRect: {
        x: +rect.left.toFixed(1),
        y: +rect.top.toFixed(1),
        width: +rect.width.toFixed(1),
        height: +rect.height.toFixed(1),
      },
    };
  });
}

/** 學生總表容器雙向捲到底，讓資料列從表頭下方通過。 */
async function scrollResultsToEnd(page: Page) {
  return page.evaluate(() => {
    const table = document.querySelector('.results-table') as HTMLElement | null;
    const scroller = table?.closest('.table-scroll') as HTMLElement | null;
    if (!scroller) throw new Error('找不到學生總表捲動容器');
    scroller.scrollLeft = Math.min(597, scroller.scrollWidth - scroller.clientWidth);
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
    return { left: scroller.scrollLeft, top: scroller.scrollTop };
  });
}

test.describe('R6-F02：核對結果頁姓名表頭不得被資料列蓋住', () => {
  for (const viewport of [
    { label: '768×600', width: 768, height: 600 },
    { label: '1440×900', width: 1440, height: 900 },
  ]) {
    test(`${viewport.label} 捲到底後姓名表頭仍在自己之上`, async ({ page }) => {
      test.setTimeout(180000);
      await ensureFixtureActivated(page);

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.locator('.data-banner-current')).toBeVisible({ timeout: 20000 });
      await expect(page.locator('.results-table tbody tr').first()).toBeVisible({ timeout: 20000 });
      await expect(page.getByText('載入學生總表中')).toHaveCount(0);
      await page.waitForTimeout(600);

      const scrolled = await scrollResultsToEnd(page);
      expect(scrolled.left, `${viewport.label} 學生總表應可水平捲動`).toBeGreaterThan(0);
      expect(scrolled.top, `${viewport.label} 應捲過表頭與首列`).toBeGreaterThan(200);
      await page.waitForTimeout(300);

      const probe = await probeNameHeader(page);
      expect(
        probe.hitsHeader,
        `${viewport.label} 姓名表頭被資料列蓋住：中心點 (${probe.point.x}, ${probe.point.y}) 命中 ${probe.hitTag}.${probe.hitClass ?? ''}「${probe.hitText}」而非 TH，表頭位置 ${JSON.stringify(probe.headerRect)}`,
      ).toBe(true);
    });
  }
});