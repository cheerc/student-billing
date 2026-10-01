import { test, expect } from '@playwright/test';
import { B2, ensureB2Activated } from './helpers/b2-roster';
import { applyFilter, chip, openFilter } from './helpers/header-filter';

for (const invalid of [false, true]) {
  test(`UX74 單班本班適用折扣：${invalid ? '失效值移除並提示' : '有效值保留'}，Back 與直接重載一致`, async ({ page }) => {
    await ensureB2Activated(page);
    await page.goto('/');
    await applyFilter(page, '所屬班級', { pick: [B2.CARE] });
    const panel = await openFilter(page, '本班適用折扣');
    const rate = panel.locator('[data-filter-option]').filter({ hasNotText: '(空白)' }).first();
    const label = await rate.getAttribute('data-filter-option');
    expect(label).toBeTruthy();
    await rate.locator('input[type="checkbox"]').check();
    await panel.getByRole('button', { name: '確定', exact: true }).click();
    await expect(chip(page, '本班適用折扣', label!)).toBeVisible();
    await page.getByRole('tab', { name: '班級扣天', exact: true }).click();
    if (invalid) {
      // 模擬手動改網址條件，不改 DOM／API／資料庫；數值合法但此班無該適用率。
      await page.evaluate(() => {
        const url = new URL(location.href);
        url.searchParams.set('applicableDiscountBps', '1234');
        history.replaceState(history.state, '', url);
      });
    }
    const before = page.url();
    const rateWire = new URL(before).searchParams.get('applicableDiscountBps');
    expect(rateWire).toBeTruthy();
    await page.locator('.deductions-table tbody > tr:not(.ded-expanded) button').first().click();
    await page.getByRole('button', { name: /編輯此班課表/ }).click();
    await expect(page.locator('[data-focus-class]')).toBeVisible();
    await page.goBack();
    await expect(page.locator('.data-banner h1')).toBeVisible();
    const selected = await page.getByRole('tab', { name: '班級扣天', exact: true }).getAttribute('aria-selected');
    console.log('UX74 applicable Back', JSON.stringify({ invalid, before, after: page.url(), selected, rateWire }));
    expect.soft(selected, 'Back 頁籤').toBe('true');
    if (!invalid) {
      expect.soft(new URL(page.url()).searchParams.get('applicableDiscountBps'), '有效適用折扣不被 stale options 剪掉').toBe(rateWire);
    }
    // 已列出真正 RED 值時終止此案例，避免在錯誤頁籤上等不存在的條件而掩蓋原始斷言。
    if (selected !== 'true') return;
    await page.getByRole('tab', { name: '學生總表', exact: true }).click();
    if (invalid) {
      await expect.soft(page.locator('[data-notice="filters-pruned"]'), '失效條件需提示').toBeVisible();
      expect.soft(new URL(page.url()).searchParams.has('applicableDiscountBps')).toBe(false);
    } else {
      await expect.soft(chip(page, '本班適用折扣', label!)).toBeVisible();
    }
    await expect(page.locator('.results-table tbody tr').first()).toBeVisible();
    const restored = {
      chips: await page.locator('[aria-label="已套用的篩選條件"]').textContent(),
      matched: await page.locator('[data-count="matched"]').textContent(),
      rows: await page.locator('.results-table tbody tr').allTextContents(),
      notice: await page.locator('[data-notice="filters-pruned"]').allTextContents(),
    };
    const control = new URL(before);
    control.searchParams.set('view', 'students');
    await page.goto(control.href);
    await expect(page.locator('.results-table tbody tr').first()).toBeVisible();
    const reloaded = {
      chips: await page.locator('[aria-label="已套用的篩選條件"]').textContent(),
      matched: await page.locator('[data-count="matched"]').textContent(),
      rows: await page.locator('.results-table tbody tr').allTextContents(),
      notice: await page.locator('[data-notice="filters-pruned"]').allTextContents(),
    };
    console.log('UX74 applicable parity', JSON.stringify({ invalid, rateWire, restored, reloaded }));
    expect(restored).toEqual(reloaded);
  });
}
