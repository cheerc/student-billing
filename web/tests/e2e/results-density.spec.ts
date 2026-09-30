import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { allStudents } from './helpers/b2-roster';
import { trigger, panel } from './helpers/header-filter';

/**
 * specs/04 UX30（合成 fixture 477 人）／UX25 面板遮擋／09 §5.1 O01 密度（11 B2）。
 *
 * UX30 計數方式（operator 2026-09-30 確認）：資料載入穩定後、學生總表未篩選；
 * 「完整可見資料列」＝該列上下緣都在表格可視區內（同時在表格捲動容器與視窗內、且在 sticky 表頭之下）。
 * 門檻：1440×900 ≥10 列；768×600 ≥4 列。
 */
const FIXTURE = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
const FIXTURE_TOTAL = 477;

async function ensureFixtureActivated(page: Page) {
  await page.goto('/');
  if ((await page.locator('.data-banner-current').count()) > 0) return;
  await page.goto('/imports');
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
  await page.locator('button', { hasText: '使用這份名單' }).click();
  await expect(page.getByText(/\d+ 位學生資料已備妥/)).toBeVisible({ timeout: 15000 });
}

/** 載入穩定：477 人、沒有「載入中」、表格有列，再等一小段讓版面定型。 */
async function openStableResults(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await expect(page.locator('.data-banner-current')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.counts-line [data-count="matched"]')).toHaveText(String(FIXTURE_TOTAL));
  await expect(page.getByText('載入學生總表中')).toHaveCount(0);
  await expect(page.locator('.results-table tbody tr').first()).toBeVisible();
  await page.waitForTimeout(400);
}

async function fullyVisibleRows(page: Page): Promise<{ full: number; rows: number; rowHeights: number[] }> {
  return page.evaluate(() => {
    const table = document.querySelector('.results-table') as HTMLElement;
    const scroller = table.closest('.table-scroll') as HTMLElement;
    const sr = scroller.getBoundingClientRect();
    const headBottom = (table.querySelector('thead') as HTMLElement).getBoundingClientRect().bottom;
    const top = Math.max(sr.top, 0, headBottom);
    const bottom = Math.min(sr.bottom, window.innerHeight);
    const rows = Array.from(table.querySelectorAll('tbody tr')) as HTMLElement[];
    let full = 0;
    const rowHeights: number[] = [];
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      rowHeights.push(Math.round(b.height));
      if (b.top >= top - 0.5 && b.bottom <= bottom + 0.5) full += 1;
    }
    return { full, rows: rows.length, rowHeights: rowHeights.slice(0, 5) };
  });
}

test.beforeEach(async ({ page }) => {
  await ensureFixtureActivated(page);
});

test.describe('UX30 密度：完整可見資料列', () => {
  test('1440×900：完整可見資料列 ≥ 10', async ({ page }) => {
    await openStableResults(page, { width: 1440, height: 900 });
    const m = await fullyVisibleRows(page);
    expect(m.rows).toBeGreaterThanOrEqual(10);
    expect(m.full, `完整可見列數 ${m.full}（列高 ${m.rowHeights.join('/')}px）`).toBeGreaterThanOrEqual(10);
  });

  test('768×600：完整可見資料列 ≥ 4（短視窗優先保留表格空間）', async ({ page }) => {
    await openStableResults(page, { width: 768, height: 600 });
    const m = await fullyVisibleRows(page);
    expect(m.full, `完整可見列數 ${m.full}（列高 ${m.rowHeights.join('/')}px）`).toBeGreaterThanOrEqual(4);
  });
});

test.describe('O01 版面密度', () => {
  test('重複說明只在表頭 tooltip：資料列不再逐列重複「指定課程可能另有調整」', async ({ page }) => {
    await openStableResults(page, { width: 1440, height: 900 });
    await expect(page.locator('.results-table tbody')).not.toContainText('指定課程可能另有調整');
    await page.locator('.results-table thead').getByRole('button', { name: /合計折扣.*說明/ }).click();
    await expect(page.getByRole('tooltip')).toContainText('指定課程可能另有調整');
  });

  test('技術資訊區預設收合；班名最多兩行＋「另 N 班」，可點擊展開全部', async ({ page }) => {
    await openStableResults(page, { width: 1440, height: 900 });
    await expect(page.locator('details.tech-info')).not.toHaveAttribute('open', '');

    const students = await allStudents(page);
    const many = students.find((s) => new Set(s.enrollments.map((e) => e.rawToken)).size >= 3);
    expect(many, 'fixture 需有報名 3 班以上的學生').toBeTruthy();
    const total = many!.enrollments.length;
    await page.getByRole('textbox', { name: '搜尋姓名或人員代碼' }).fill(many!.personCode);
    await expect(page.locator('.counts-line [data-count="matched"]')).toHaveText('1');
    const row = page.locator('.results-table tbody tr').first();
    const classCell = row.locator('td').nth(2);
    // 班名最多兩行；「另 N 班」在第二行尾端，可點擊展開全部
    const nameLines = classCell.locator('.enroll-line');
    await expect(nameLines).toHaveCount(2);
    await expect(nameLines.nth(1)).toContainText(`另 ${total - 2} 班`);
    await classCell.getByRole('button', { name: `另 ${total - 2} 班` }).click();
    await expect(classCell.locator('.enroll-line')).toHaveCount(total);
  });
});

test.describe('UX25 面板可見性：768×600 與 1024×768 下不被裁切、確定鈕可見、Esc 回焦點', () => {
  for (const viewport of [{ width: 768, height: 600 }, { width: 1024, height: 768 }]) {
    test(`${viewport.width}×${viewport.height}：各欄面板完整在視窗內，確定鈕可見且未被遮擋`, async ({ page }) => {
      await openStableResults(page, viewport);
      const scroller = page.locator('.table-scroll').first();
      for (const column of ['所屬班級', '年級', '需確認', '園內生']) {
        // 表內先捲到該欄（最右側欄位會超出可視寬度）與往下捲，確認 sticky 表頭與 overflow 不裁切面板
        await scroller.evaluate((el) => { el.scrollTop = 300; });
        const t = trigger(page, column);
        await t.scrollIntoViewIfNeeded();
        await t.click();
        const p = panel(page, column);
        await expect(p).toBeVisible();

        const box = (await p.boundingBox())!;
        expect(box.x, `${column} 面板左緣`).toBeGreaterThanOrEqual(-0.5);
        expect(box.y, `${column} 面板上緣`).toBeGreaterThanOrEqual(-0.5);
        expect(box.x + box.width, `${column} 面板右緣`).toBeLessThanOrEqual(viewport.width + 0.5);
        expect(box.y + box.height, `${column} 面板下緣`).toBeLessThanOrEqual(viewport.height + 0.5);

        // 面板四角與確定鈕中心都是面板自己（沒有被 sticky 表頭、表格容器或底部元素遮住／裁切）
        const covered = await p.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const pts: Array<[number, number]> = [
            [r.left + 3, r.top + 3], [r.right - 3, r.top + 3], [r.left + 3, r.bottom - 3], [r.right - 3, r.bottom - 3],
          ];
          const ok = Array.from(el.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === '確定') as HTMLElement;
          const br = ok.getBoundingClientRect();
          pts.push([br.left + br.width / 2, br.top + br.height / 2]);
          return pts.filter(([x, y]) => !el.contains(document.elementFromPoint(x, y))).length;
        });
        expect(covered, `${column} 面板有 ${covered} 個取樣點被其他元素蓋住或裁切`).toBe(0);
        const okBox = (await p.getByRole('button', { name: '確定', exact: true }).boundingBox())!;
        expect(okBox.y + okBox.height).toBeLessThanOrEqual(viewport.height + 0.5);

        // 選項清單是面板內可捲動的區塊（不撐出面板）
        if (column === '所屬班級') {
          const list = p.locator('[data-filter-list]');
          const scrollable = await list.evaluate((el) => ({
            overflowY: getComputedStyle(el).overflowY,
            scrolls: el.scrollHeight > el.clientHeight,
          }));
          expect(['auto', 'scroll']).toContain(scrollable.overflowY);
          expect(scrollable.scrolls, '班級選項多，清單應在面板內捲動').toBe(true);
        }

        await page.keyboard.press('Escape');
        await expect(p).toHaveCount(0);
        await expect(t).toBeFocused();
      }
    });
  }
});
