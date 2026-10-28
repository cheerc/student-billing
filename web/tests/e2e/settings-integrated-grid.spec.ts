import { test, expect } from '@playwright/test';

/**
 * #80 & D61 (UX106, UX107): 單一表格整合屬性（YesNoRadioGroup 單選與 5 頁籤）E2E 驗收
 *
 * 驗收目標：
 *  1. 課表頁以 5 頁籤呈現，不重複顯示獨立屬性面板；
 *  2. 排課頁籤設定「是否有多科折扣」與「不計扣天」；安親頁籤設定「天數固定 5 天」；
 *  3. UX107: YesNoRadioGroup 點擊操作、同班多列第 2 列顯示「↳ 同本班（是/否）」；
 *  4. 表格工具列維持「＋ 新增班級」；
 *  5. 窄視窗下表格 2D 捲動正常，首欄 sticky 凍結。
 */

test.describe('#80 & D61: 單一表格整合屬性與 YesNoRadioGroup E2E 驗收', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.schedule-table')).toBeVisible();
  });

  test('#80-1: 課表頁只有當前頁籤的一張表格，獨立的屬性卡片已移除', async ({ page }) => {
    await expect(page.locator('table.schedule-table')).toHaveCount(1);
    await expect(page.locator('[data-class-attributes-panel]')).toHaveCount(0);
    await expect(page.getByText('折扣類別與固定 5 天（')).toHaveCount(0);
  });

  test('UX106 & UX107: 排課頁籤設定多科折扣與不計扣天；同班第 2 列顯示「↳ 同本班」', async ({ page }) => {
    // 切換至 [數學班] 頁籤
    await page.locator('#class-type-tab-math').click();
    const mathThead = page.locator('table.schedule-table-math thead');
    await expect(mathThead).toContainText('班級名稱');
    await expect(mathThead).toContainText('是否有多科折扣');
    await expect(mathThead).toContainText('不計扣天');
    await expect(mathThead).not.toContainText('天數固定 5 天');

    // 國小數學-四A 在種子資料中恰有 2 列時段
    const rows = page.locator('table.schedule-table-math tr.schedule-row', {
      has: page.locator('input[value="國小數學-四A"]'),
    });
    await expect(rows).toHaveCount(2);

    // 第 1 列為單選組
    await expect(rows.first().locator('div[role="radiogroup"][aria-label="國小數學-四A 的是否有多科折扣"]')).toBeVisible();
    // 第 2 列為「↳ 同本班」靜態標記
    await expect(rows.nth(1).locator('.same-class-marker')).toContainText('↳ 同本班');

    // 兩列各自有獨立的不計扣天單選組
    await expect(rows.first().locator('.col-skip-deduction div[role="radiogroup"]')).toBeVisible();
    await expect(rows.nth(1).locator('.col-skip-deduction div[role="radiogroup"]')).toBeVisible();

    // 切換至安親頁籤：包含天數固定 5 天
    await page.locator('#class-type-tab-care').click();
    const careThead = page.locator('table.schedule-table-care thead');
    await expect(careThead).toContainText('天數固定 5 天');
    await expect(careThead).not.toContainText('不計扣天');
    await expect(page.locator('div[role="radiogroup"][aria-label="國小輔導-四年級 的天數固定 5 天"]')).toBeVisible();
  });

  test('UX107: 點擊 YesNoRadioGroup 單選項即時切換狀態並產生未儲存變更', async ({ page }) => {
    // 預設在 [安親課輔班] 頁籤
    const g4FixedRadio = page.locator('div[role="radiogroup"][aria-label="國小輔導-四年級 的天數固定 5 天"]');
    await expect(g4FixedRadio).toBeVisible();

    // 預設固定 5 天為「否」
    await expect(g4FixedRadio.locator('input[value="false"]')).toBeChecked();

    // 點擊「是」
    await g4FixedRadio.locator('label.yes-option').click();
    await expect(g4FixedRadio.locator('input[value="true"]')).toBeChecked();

    // 出現「有未儲存的變更」提示
    await expect(page.locator('.savebar-status')).toContainText('有未儲存的變更');
  });

  test('#80-4: 「＋ 新增班級」仍在表格工具列', async ({ page }) => {
    const toolbar = page.locator('.schedule-grid-container .toolbar');
    await expect(toolbar.getByRole('button', { name: '＋ 新增班級' })).toBeVisible();
  });

  test('#80-5: 欄位超出螢幕時，表格在容器內 2D 捲動、整頁不橫向溢出', async ({ page }) => {
    // 切換至排課頁籤（12 欄）
    await page.locator('#class-type-tab-english').click();
    await page.setViewportSize({ width: 900, height: 800 });

    const metrics = await page.evaluate(() => {
      const el = document.querySelector('.schedule-table-scroll') as HTMLElement | null;
      if (!el) throw new Error('找不到 .schedule-table-scroll');
      const style = getComputedStyle(el);
      return {
        pageOverflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
      };
    });

    expect(metrics.pageOverflowPx).toBeLessThanOrEqual(0);
    expect(['auto', 'scroll']).toContain(metrics.overflowX);
    expect(['auto', 'scroll']).toContain(metrics.overflowY);
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);

    const stickyLeft = await page.evaluate(() => {
      const container = document.querySelector('.schedule-table-scroll') as HTMLElement;
      container.scrollLeft = container.scrollWidth;
      const box = container.getBoundingClientRect();
      const cell = document.querySelector('table.schedule-table tbody .sticky-col');
      if (!cell) throw new Error('找不到 sticky 首欄');
      return cell.getBoundingClientRect().left - box.left;
    });
    expect(stickyLeft).toBeGreaterThanOrEqual(-1);
    expect(stickyLeft).toBeLessThanOrEqual(1);
  });
});
