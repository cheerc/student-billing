import { test, expect } from '@playwright/test';

const VIEWPORTS = [
  { label: '768×600', width: 768, height: 600 },
  { label: '1440×900', width: 1440, height: 900 },
];

test.describe('R5-F01：課表兩層固定表頭', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.label} 雙向捲動後兩層表頭與左上角仍可見`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/settings');
      await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });

      const container = page.locator('.schedule-table-scroll');
      const table = page.locator('table.schedule-table');
      await expect(table).toBeVisible();
      await container.scrollIntoViewIfNeeded();

      const initialScroll = await container.evaluate((el) => ({
        maxLeft: el.scrollWidth - el.clientWidth,
        maxTop: el.scrollHeight - el.clientHeight,
      }));
      expect(initialScroll.maxLeft, `${viewport.label} 課表應可水平捲動`).toBeGreaterThan(0);
      expect(initialScroll.maxTop, `${viewport.label} 課表應可垂直捲動`).toBeGreaterThan(200);

      const firstDataRowTopBefore = await page.evaluate(() => {
        const containerEl = document.querySelector<HTMLElement>('.schedule-table-scroll');
        const row = document.querySelector<HTMLElement>('.schedule-table tbody tr');
        if (!containerEl || !row) throw new Error('找不到課表捲動容器或資料列');
        return row.getBoundingClientRect().top - containerEl.getBoundingClientRect().top;
      });

      const actualScroll = await container.evaluate((el, requested) => {
        el.scrollLeft = Math.min(requested.left, el.scrollWidth - el.clientWidth);
        el.scrollTop = Math.min(requested.top, el.scrollHeight - el.clientHeight);
        return { left: el.scrollLeft, top: el.scrollTop };
      }, { left: 506, top: 3790 });
      expect(actualScroll.left, `${viewport.label} 必須實際水平捲動`).toBeGreaterThan(0);
      expect(actualScroll.top, `${viewport.label} 必須捲過表頭與首列`).toBeGreaterThan(200);

      const groupLocators = [
        table.locator('thead tr:first-child th.col-group-anqin'),
        table.locator('thead tr:first-child th.col-group-tutoring'),
      ];
      const groupBoxes = (await Promise.all(groupLocators.map((locator) => locator.boundingBox()))).map((box) => {
        if (!box) throw new Error(`${viewport.label} 群組表頭沒有 bounding box`);
        return box;
      });
      const secondRowBoxes = (await Promise.all(
        (await table.locator('thead tr:nth-child(2) th').all()).map((locator) => locator.boundingBox())
      )).map((box) => {
        if (!box) throw new Error(`${viewport.label} 子欄表頭沒有 bounding box`);
        return box;
      });
      expect(secondRowBoxes).toHaveLength(4);

      const containerBox = await container.boundingBox();
      const cornerBox = await table.locator('thead th.sticky-corner').boundingBox();
      if (!containerBox || !cornerBox) throw new Error(`${viewport.label} 表頭或捲動容器沒有 bounding box`);

      const groupTop = Math.min(...groupBoxes.map((box) => box.y));
      const groupBottom = Math.max(...groupBoxes.map((box) => box.y + box.height));
      const secondRowTop = Math.min(...secondRowBoxes.map((box) => box.y));
      expect(Math.abs(groupTop - containerBox.y), `${viewport.label} 群組表頭應貼齊容器上緣`).toBeLessThanOrEqual(2);
      expect(secondRowTop, `${viewport.label} 第二列子欄不得蓋住第一列群組表頭`).toBeGreaterThanOrEqual(groupBottom - 1);
      expect(secondRowTop, `${viewport.label} 兩列之間不得露出資料列`).toBeLessThanOrEqual(groupBottom + 1);
      expect(Math.abs(cornerBox.x - containerBox.x), `${viewport.label} 班級名稱欄應貼齊容器左緣`).toBeLessThanOrEqual(1);
      expect(Math.abs(cornerBox.y - containerBox.y), `${viewport.label} 班級名稱角落應貼齊容器上緣`).toBeLessThanOrEqual(2);

      const titleProbes = await page.evaluate(() => {
        const containerEl = document.querySelector<HTMLElement>('.schedule-table-scroll');
        if (!containerEl) throw new Error('找不到課表捲動容器');
        const containerRect = containerEl.getBoundingClientRect();
        const targets = [
          { name: '安親窗口', selector: '.schedule-table thead th.col-group-anqin' },
          { name: '課輔窗口', selector: '.schedule-table thead th.col-group-tutoring' },
          { name: '班級名稱', selector: '.schedule-table thead th.sticky-corner' },
        ];
        return targets.map(({ name, selector }) => {
          const target = document.querySelector<HTMLElement>(selector);
          if (!target) throw new Error(`找不到${name}表頭`);
          const range = document.createRange();
          range.selectNodeContents(target);
          const rect = range.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          return {
            name,
            text: target.textContent?.trim(),
            pointInsideScrollport:
              x >= containerRect.left && x <= containerRect.right && y >= containerRect.top && y <= containerRect.bottom,
            pointHitsTarget: hit === target || (hit !== null && target.contains(hit)),
          };
        });
      });
      expect(titleProbes.map((probe) => probe.text)).toEqual([
        '安親窗口 (13:00–16:00)',
        '課輔窗口 (16:30–19:30)',
        '班級名稱',
      ]);
      for (const probe of titleProbes) {
        expect(probe.pointInsideScrollport, `${viewport.label}「${probe.name}」文字應在可視捲動區內`).toBe(true);
        expect(probe.pointHitsTarget, `${viewport.label}「${probe.name}」文字點不得被其他表格儲存格遮住`).toBe(true);
      }

      const firstDataRowTopAfter = await page.evaluate(() => {
        const containerEl = document.querySelector<HTMLElement>('.schedule-table-scroll');
        const row = document.querySelector<HTMLElement>('.schedule-table tbody tr');
        if (!containerEl || !row) throw new Error('找不到課表捲動容器或資料列');
        return row.getBoundingClientRect().top - containerEl.getBoundingClientRect().top;
      });
      expect(firstDataRowTopBefore - firstDataRowTopAfter, `${viewport.label} 資料列應已離開原位`).toBeGreaterThan(100);
    });
  }
});
