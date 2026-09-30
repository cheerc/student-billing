import { test, expect } from '@playwright/test';
import path from 'path';

/**
 * 04 §8 UX26／09 §5.2（11 §3 A；F02）：班級扣天的狀態同時考慮安親與課輔兩側。
 *
 * 前置：以合成 fixture 上傳並啟用名單（結果頁的班級扣天需要 active run），課表為 seed。
 * seed 中「只與課輔窗口重疊」的班很多，例如 兒童美語-Chevady（課輔實扣 2 天、安親 0），
 * operator 驗收時共觀察到 22 列狀態寫「無重疊」卻有課輔扣天。
 *
 * 判準（手算）：某班安親原始或課輔原始扣除任一側 > 0 ＝ 該班有重疊 → 狀態不得是「無重疊」。
 */
test.describe('UX26：班級扣天狀態涵蓋安親與課輔兩側', () => {
  test('只與課輔重疊的班（兒童美語-Chevady）狀態不是「無重疊」；全表沒有「有扣天卻寫無重疊」的列', async ({ page }) => {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.getByText(/\d+ 位學生資料已備妥/)).toBeVisible({ timeout: 15000 });

    await page.goto('/?view=deductions');
    await page.locator('button[role="tab"]', { hasText: '班級扣天' }).click();
    const table = page.locator('.deductions-table');
    await expect(table).toBeVisible();

    // 指定案例：課輔原始 2.000 天、實際 2 天；安親 0
    const chevady = table.locator('tbody tr', { hasText: '兒童美語-Chevady' }).first();
    await expect(chevady.locator('td').nth(3)).toHaveText('0.000'); // 安親原始
    await expect(chevady.locator('td').nth(5)).toHaveText('2.000'); // 課輔原始
    await expect(chevady.locator('td').nth(6)).toHaveText('2'); // 課輔實際
    await expect(chevady.locator('.ded-status')).not.toHaveText('無重疊');
    await expect(chevady.locator('.ded-status')).toHaveText('已計算');

    // 全表：任一側有扣天 → 狀態不得是「無重疊」
    const rows = await table.locator('tbody > tr:not(.ded-expanded)').evaluateAll((trs) =>
      trs.map((tr) => {
        const tds = Array.from(tr.querySelectorAll('td'));
        return {
          name: (tds[0]?.textContent ?? '').trim(),
          anqinRaw: Number(tds[3]?.textContent ?? 'NaN'),
          tutoringRaw: Number(tds[5]?.textContent ?? 'NaN'),
          status: (tds[7]?.textContent ?? '').trim(),
        };
      })
    );
    expect(rows.length).toBeGreaterThan(40); // seed 49 班
    const contradictions = rows.filter((r) => (r.anqinRaw > 0 || r.tutoringRaw > 0) && r.status === '無重疊');
    expect(contradictions, JSON.stringify(contradictions)).toEqual([]);
    // 真的「無重疊」的列仍存在時才驗證它們兩側皆為 0
    for (const r of rows.filter((x) => x.status === '無重疊')) {
      expect(r.anqinRaw).toBe(0);
      expect(r.tutoringRaw).toBe(0);
    }
  });
});
