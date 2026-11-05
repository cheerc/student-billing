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

/**
 * UX126（D65 G5）：班級扣天表頭排序。兩態切換，點另一欄從升冪開始、前一欄失去 aria-sort；動作類欄位無排序鈕。
 */
test.describe('UX126：班級扣天表頭排序', () => {
  test('點「班級」→ ascending，再點 → descending，點「老師」→ 老師 ascending 且班級無 aria-sort', async ({ page }) => {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.getByText(/\d+ 位學生資料已備妥/)).toBeVisible({ timeout: 15000 });

    await page.goto('/?view=deductions');
    await page.locator('button[role="tab"]', { hasText: '班級扣天' }).click();
    const table = page.locator('.deductions-table');
    await expect(table).toBeVisible();

    const classTh = table.locator('thead th', { hasText: '班級' }).first();
    const teacherTh = table.locator('thead th', { hasText: '老師' }).first();
    await expect(classTh).not.toHaveAttribute('aria-sort', /.+/);

    await classTh.locator('button.th-sort').click();
    await expect(classTh).toHaveAttribute('aria-sort', 'ascending');
    await classTh.locator('button.th-sort').click();
    await expect(classTh).toHaveAttribute('aria-sort', 'descending');

    await teacherTh.locator('button.th-sort').click();
    await expect(teacherTh).toHaveAttribute('aria-sort', 'ascending');
    await expect(classTh).not.toHaveAttribute('aria-sort', /.+/);

    // 降冪時安親實際扣除欄：第一列是全表最大值（以頁面上全部列讀出的數字獨立比較）
    const actualTh = table.locator('thead th', { hasText: '安親實際扣除' }).first();
    await actualTh.locator('button.th-sort').click();
    await actualTh.locator('button.th-sort').click();
    await expect(actualTh).toHaveAttribute('aria-sort', 'descending');
    const col = await table.locator('tbody > tr:not(.ded-expanded)').evaluateAll((trs) =>
      trs.map((tr) => Number(tr.querySelectorAll('td')[4]?.textContent ?? 'NaN')),
    );
    expect(col.length).toBeGreaterThan(40);
    expect(col[0]).toBe(Math.max(...col));
    for (let i = 1; i < col.length; i++) expect(col[i - 1]!).toBeGreaterThanOrEqual(col[i]!);

    // 無排序鈕的欄：上課時間
    const timeTh = table.locator('thead th', { hasText: '上課時間' }).first();
    await expect(timeTh.locator('button.th-sort')).toHaveCount(0);
  });
});
