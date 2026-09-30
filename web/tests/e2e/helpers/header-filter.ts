import { expect, type Locator, type Page } from '@playwright/test';

/**
 * 表頭篩選（D36；specs/09 §5.1）的瀏覽器操作共用工具。
 *
 * 契約（RED 與 GREEN 共用）：
 *   - 觸發鈕：`button[aria-label="{欄名}篩選"]`，aria-haspopup="dialog"、aria-expanded；有套用條件時 data-filter-active="true"
 *   - 面板：role="dialog"、aria-label="{欄名}篩選面板"；內含搜尋框（aria-label="搜尋{欄名}選項"）、
 *     按鈕「全選搜尋結果」「取消全選」「確定」「取消」、每個選項一個 checkbox（label 含選項名與人數）
 *   - 已套用條件：`[aria-label="已套用的篩選條件"]`，每個條件一顆 `移除 {欄名}：{值}` 鈕，另有「清除全部」
 */

export const trigger = (page: Page, column: string): Locator =>
  page.locator(`button[aria-label="${column}篩選"]`);

export const panel = (page: Page, column: string): Locator =>
  page.getByRole('dialog', { name: `${column}篩選面板` });

export const chips = (page: Page): Locator => page.locator('[aria-label="已套用的篩選條件"]');

export const chip = (page: Page, column: string, value?: string | RegExp): Locator =>
  chips(page).locator(
    value === undefined ? `button[aria-label^="移除 ${column}："]` : `button[aria-label="移除 ${column}：${value}"]`
  );

export async function openFilter(page: Page, column: string): Promise<Locator> {
  await trigger(page, column).click({ timeout: 10_000 });
  const p = panel(page, column);
  await expect(p).toBeVisible({ timeout: 10_000 });
  return p;
}

export function option(p: Locator, label: string | RegExp): Locator {
  return p.locator('label', { hasText: label }).locator('input[type="checkbox"]');
}

/** 選項顯示名稱（去除人數）清單：面板目前可見的選項。 */
export async function visibleOptionLabels(p: Locator): Promise<string[]> {
  return p.locator('[data-filter-option]').evaluateAll((els) =>
    els.map((el) => (el.getAttribute('data-filter-option') ?? '').trim())
  );
}

export interface ApplyOptions {
  /** 逐一勾選（label 為選項名稱，完全比對） */
  pick?: string[];
  /** 輸入關鍵字後按「全選搜尋結果」 */
  searchAll?: string;
  /** 取消全選（0 筆）後確定 */
  none?: boolean;
}

/** 開面板 → 操作 → 按「確定」。 */
export async function applyFilter(page: Page, column: string, opts: ApplyOptions): Promise<void> {
  const p = await openFilter(page, column);
  if (opts.none) await p.getByRole('button', { name: '取消全選' }).click();
  if (opts.searchAll !== undefined) {
    await p.getByRole('textbox', { name: `搜尋${column}選項` }).fill(opts.searchAll);
    await p.getByRole('button', { name: '全選搜尋結果' }).click();
  }
  for (const label of opts.pick ?? []) {
    await p.locator(`[data-filter-option="${label}"] input[type="checkbox"]`).check();
  }
  await p.getByRole('button', { name: '確定' }).click();
  await expect(p).toHaveCount(0);
}

export const matchedCount = async (page: Page): Promise<number> =>
  Number(await page.locator('.counts-line [data-count="matched"]').textContent());

export const urlParams = (page: Page): URLSearchParams => new URL(page.url()).searchParams;
